/**
 * El servicio de punta a punta, sin red: identidades de Node reales, un PayPal fingido y unas
 * pilas fingidas. Lo que se prueba es lo que decide el servicio: crear UNA réplica por compra,
 * atarla a la cuenta que firma la compra, enrolarla solo con la invitación de esa cuenta, dejar
 * que solo ella la vea y la cancele, encenderla o apagarla según lo que diga PayPal (no lo que
 * diga un aviso), y borrar y devolver lo cobrado de una que nadie enroló.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Identity } from '@dotrino/identity/node'
import { pubkeyId } from '@dotrino/identity/keyid'
import { Store } from '../src/store.js'
import { Accounts, AUDIENCE, FORMAT_V, PRODUCT } from '../src/accounts.js'
import { makeHandler } from '../src/http.js'

const require = createRequire(import.meta.url)
const DAY = 24 * 60 * 60 * 1000
const PLAN = 'P-TEST'
let clock = Date.UTC(2026, 9, 18)
const now = () => clock

const dirs = []
const ids = []
async function account () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'))
  dirs.push(dir)
  const id = await Identity.connect({ dir })
  ids.push(id)
  const { profileId } = await id.signData({ aud: AUDIENCE, probe: true })
  return { id, account: await pubkeyId(profileId) }
}
const req = async (who, fields, { exp = clock + 60_000 } = {}) => {
  const body = { v: FORMAT_V, aud: AUDIENCE, iat: clock, exp, nonce: randomUUID(), ...fields }
  const s = await who.id.signData(body)
  return { body, signature: s.signature, publickey: s.publickey, chain: s.chain }
}

function fakePaypal () {
  const subs = new Map()
  return {
    subs,
    webhookOk: true,
    async createSubscription ({ planId, customId }) {
      const id = 'I-' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
      subs.set(id, { id, status: 'APPROVAL_PENDING', planId, customId, paidThrough: null })
      return { id, approveUrl: 'https://paypal.test/approve/' + id }
    },
    async getSubscription (id) { const s = subs.get(id); if (!s) throw Object.assign(new Error('nope'), { code: 'provider-not-found' }); return { ...s } },
    async cancelSubscription (id) { const s = subs.get(id); s.status = 'CANCELLED'; s.paidThrough = null },
    payments: new Map(),
    refunds: [],
    async subscriptionPayments (id) { return (this.payments.get(id) || []).map((p) => ({ ...p })) },
    async refundCapture (captureId) { this.refunds.push(captureId); for (const ps of this.payments.values()) for (const p of ps) if (p.id === captureId) p.status = 'REFUNDED'; return { id: 'R' + captureId, status: 'COMPLETED' } },
    async verifyWebhook () { return this.webhookOk },
    approve (id) { Object.assign(subs.get(id), { status: 'ACTIVE', paidThrough: clock + 30 * DAY }) }
  }
}

function fakeVaults () {
  const stacks = new Map()
  return {
    stacks,
    invocations: [],
    async create ({ vault, owner }) { stacks.set(vault, { owner, state: 'creating', on: true, enrolled: false, device: null }) },
    async describe (vault) {
      const s = stacks.get(vault)
      return s.state === 'ready' ? { state: 'ready' } : { state: s.state, reason: s.reason }
    },
    async invoke (vault, payload) {
      this.invocations.push([vault, payload])
      const s = stacks.get(vault)
      if (payload.kind === 'enroll') {
        if (payload.invitation === 'caducada') return { ok: false, error: 'enroll-failed', message: 'invalid or expired pairing token' }
        s.device = 'AB12-CD34'
        return { ok: true, deviceId: s.device, code: '123456' }
      }
      if (payload.kind === 'status') return { ok: true, enrolled: s.enrolled, deviceId: s.enrolled ? s.device : null, seq: s.enrolled ? 3 : 0 }
      return { ok: false, error: 'unknown' }
    },
    async remove (vault) { stacks.get(vault).removed = true },
    async setOn (vault, on) { stacks.get(vault).on = on },
    finish (vault) { stacks.get(vault).state = 'ready' },
    approve (vault) { stacks.get(vault).enrolled = true }
  }
}

let ana, beto
test.before(async () => { ;[ana, beto] = await Promise.all([account(), account()]) })
test.after(() => { for (const id of ids) id.destroy?.(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function setup () {
  const paypal = fakePaypal()
  const vaults = fakeVaults()
  const accounts = new Accounts({ store: new Store(), vaults, paypal, planId: PLAN, webhookId: 'WH-1', now })
  return { paypal, vaults, accounts }
}

const subscribe = async (t, who = ana) => t.accounts.subscribe({ req: await req(who, { op: 'subscribe', product: PRODUCT }) })
const confirm = async (t, id, who = ana) => t.accounts.confirm({ id, req: await req(who, { op: 'confirm', id }) })
const enroll = async (t, id, invitation = 'cINVITE', who = ana) => t.accounts.enroll({ id, invitation, req: await req(who, { op: 'enroll', id }) })
const mine = async (t, who = ana) => t.accounts.mine({ req: await req(who, { op: 'mine' }) })

/** Compra, aprueba en PayPal, confirma, deja la pila lista y la enrola. */
async function bought (t) {
  const { id } = await subscribe(t)
  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  await confirm(t, id)
  const vault = t.accounts.store.get(id).vault
  t.vaults.finish(vault)
  await enroll(t, id)
  t.vaults.approve(vault)
  clock += 11_000
  const [ready] = await mine(t)
  return { id, vault, ready }
}

test('comprar: la compra la firma la cuenta; sin aprobar en PayPal no hay réplica; aprobada se crea UNA', async () => {
  const t = setup()
  const { id, price } = await subscribe(t)
  assert.equal(price.total, '3.45')
  assert.equal(t.accounts.store.get(id).account, ana.account, 'la réplica es de quien firma la compra')
  const pending = await confirm(t, id)
  assert.equal(pending.status, 'APPROVAL_PENDING')
  assert.equal(t.vaults.stacks.size, 0)

  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  const c = await confirm(t, id)
  assert.equal(c.stack, 'creating')
  await confirm(t, id)
  assert.equal(t.vaults.stacks.size, 1, 'confirmar dos veces no crea otra réplica')
  assert.equal([...t.vaults.stacks.values()][0].owner, ana.account, 'la réplica nace sabiendo qué cuenta la pagó')
  await assert.rejects(confirm(t, id, beto), { code: 'sub-not-found' })
  await assert.rejects(t.accounts.subscribe({ req: await req(ana, { op: 'subscribe', product: 'vault' }) }), { code: 'request-mismatch' })
})

test('enrolar: solo con la invitación, solo la cuenta dueña, y hasta que el dueño aprueba el código', async () => {
  const t = setup()
  const { id } = await subscribe(t)
  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  await confirm(t, id)
  const vault = t.accounts.store.get(id).vault
  await assert.rejects(enroll(t, id), { code: 'not-ready' })
  t.vaults.finish(vault)

  await assert.rejects(enroll(t, id, 'cINVITE', beto), { code: 'sub-not-found' })
  await assert.rejects(enroll(t, id, '  '), { code: 'bad-request' })
  await assert.rejects(enroll(t, id, 'caducada'), { code: 'enroll-failed' })
  const e = await enroll(t, id)
  assert.equal(e.code, '123456', 'el código para aprobar en su bóveda')
  assert.equal(e.device, 'AB12-CD34')
  assert.deepEqual(t.vaults.invocations.find(([, p]) => p.kind === 'enroll' && p.invitation === 'cINVITE')[0], vault)

  // Sin aprobar sigue sin enrolar; al aprobar, `mine` lo ve.
  clock += 11_000
  assert.equal((await mine(t))[0].enrolled, false)
  t.vaults.approve(vault)
  clock += 11_000
  const [m] = await mine(t)
  assert.equal(m.enrolled, true)
  assert.equal(m.device, 'AB12-CD34')
  await assert.rejects(enroll(t, id), { code: 'already-enrolled' })
})

test('una réplica que nadie enroló en un día se borra y se devuelve lo cobrado', async () => {
  const t = setup()
  const { id } = await subscribe(t)
  const pid = t.accounts.store.get(id).paypal_id
  t.paypal.approve(pid)
  await confirm(t, id)
  const vault = t.accounts.store.get(id).vault
  t.vaults.finish(vault)
  await confirm(t, id)
  t.paypal.payments.set(pid, [{ id: 'CAP0000001', status: 'COMPLETED', amount: '3.45' }])
  clock += 2 * DAY
  await t.accounts.sweep()
  const row = t.accounts.store.get(id)
  assert.equal(row.stack, 'deleted')
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.refund, 'done')
  assert.equal(t.vaults.stacks.get(vault).removed, true)
  assert.deepEqual(t.paypal.refunds, ['CAP0000001'])
  clock -= 2 * DAY
})

test('una enrolada no se borra aunque pase el día', async () => {
  const t = setup()
  const { vault } = await bought(t)
  clock += 2 * DAY
  await t.accounts.sweep()
  assert.equal(t.vaults.stacks.get(vault).removed, undefined)
  clock -= 2 * DAY
})

test('una suscripción de otro plan o de otra compra no crea nada', async () => {
  const t = setup()
  const { id } = await subscribe(t)
  const sub = t.paypal.subs.get(t.accounts.store.get(id).paypal_id)
  t.paypal.approve(sub.id)
  sub.planId = 'P-OTHER'
  await assert.rejects(confirm(t, id), { code: 'subscription-mismatch' })
  sub.planId = PLAN
  sub.customId = randomUUID()
  await assert.rejects(confirm(t, id), { code: 'subscription-mismatch' })
  assert.equal(t.vaults.stacks.size, 0)
})

test('si la pila falla, no se cobra el mes siguiente: la suscripción se cancela', async () => {
  const t = setup()
  const { id } = await subscribe(t)
  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  await confirm(t, id)
  const [vault] = t.vaults.stacks.keys()
  Object.assign(t.vaults.stacks.get(vault), { state: 'failed', reason: 'ROLLBACK_COMPLETE' })
  const v = await confirm(t, id)
  assert.equal(v.stack, 'failed')
  assert.equal(v.status, 'CANCELLED')
})

test('si la pila falla, el primer mes se devuelve, aunque PayPal lo apunte después', async () => {
  const t = setup()
  const { id } = await subscribe(t)
  const pid = t.accounts.store.get(id).paypal_id
  t.paypal.approve(pid)
  await confirm(t, id)
  const [vault] = t.vaults.stacks.keys()
  Object.assign(t.vaults.stacks.get(vault), { state: 'failed', reason: 'ROLLBACK_COMPLETE' })
  await confirm(t, id)
  assert.equal(t.accounts.store.get(id).refund, 'pending', 'todavía no hay cobro que devolver')
  t.paypal.payments.set(pid, [{ id: 'CAP0000001', status: 'COMPLETED', amount: '3.45' }])
  await t.accounts.sweep()
  assert.deepEqual(t.paypal.refunds, ['CAP0000001'])
  assert.equal(t.accounts.store.get(id).refund, 'done')
  await t.accounts.sweep()
  assert.deepEqual(t.paypal.refunds, ['CAP0000001'], 'no se devuelve dos veces')
})

test('la cuenta dueña ve y cancela la suya; otra cuenta no', async () => {
  const t = setup()
  const { id, vault } = await bought(t)
  const m = await mine(t)
  assert.deepEqual(m.map((s) => s.id), [id])
  assert.equal(m[0].product, 'replica')
  assert.deepEqual(await mine(t, beto), [])

  await assert.rejects(t.accounts.cancel({ id, req: await req(beto, { op: 'cancel', id }) }), { code: 'sub-not-found' })
  await assert.rejects(t.accounts.cancel({ id, req: await req(ana, { op: 'cancel', id: 'otra' }) }), { code: 'request-mismatch' })
  const r = await req(ana, { op: 'cancel', id })
  const c = await t.accounts.cancel({ id, req: r })
  assert.equal(c.status, 'CANCELLED')
  assert.equal(c.on, true, 'cancelada sigue encendida hasta el fin de lo pagado')
  await assert.rejects(t.accounts.cancel({ id, req: r }), { code: 'replayed' })

  clock += 31 * DAY
  await t.accounts.sweep()
  assert.equal(t.vaults.stacks.get(vault).on, false, 'pasado lo pagado se apaga')
  assert.ok(t.vaults.stacks.has(vault), 'y no se borra')
  clock -= 31 * DAY
})

test('suspendida por impago: se apaga al vencer lo pagado y vuelve al pagar', async () => {
  const t = setup()
  const { id, vault } = await bought(t)
  const sub = t.paypal.subs.get(t.accounts.store.get(id).paypal_id)
  clock += 31 * DAY
  sub.status = 'SUSPENDED'
  await t.accounts.sweep()
  assert.equal(t.vaults.stacks.get(vault).on, false)
  Object.assign(sub, { status: 'ACTIVE', paidThrough: clock + 30 * DAY })
  await t.accounts.sweep()
  assert.equal(t.vaults.stacks.get(vault).on, true)
  clock -= 31 * DAY
})

test('el webhook: sin la firma de PayPal no cuenta; con ella se mira PayPal, una vez por aviso', async () => {
  const t = setup()
  const { id, vault } = await bought(t)
  const paypalId = t.accounts.store.get(id).paypal_id
  const sub = t.paypal.subs.get(paypalId)
  clock += 31 * DAY
  sub.status = 'CANCELLED'
  sub.paidThrough = null
  const raw = JSON.stringify({ id: 'WH-EV-1', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: paypalId, status: 'ACTIVE' } })
  t.paypal.webhookOk = false
  await assert.rejects(t.accounts.webhook({ headers: {}, raw }), { code: 'bad-webhook-signature' })
  assert.equal(t.vaults.stacks.get(vault).on, true)
  t.paypal.webhookOk = true
  await t.accounts.webhook({ headers: {}, raw })
  assert.equal(t.accounts.store.get(id).status, 'CANCELLED', 'lo que se apunta es lo que dice PayPal, no el cuerpo del aviso')
  assert.equal(t.vaults.stacks.get(vault).on, false)
  clock -= 31 * DAY
})

test('por HTTP: precio, compra firmada y errores con su código', async () => {
  const t = setup()
  const server = http.createServer(makeHandler({ accounts: t.accounts, version: '0.1.0' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) })
  try {
    assert.equal((await (await fetch(base + '/price')).json()).total, '3.45')
    const unsigned = await post('/subscribe', {})
    assert.equal(unsigned.status, 400)
    assert.equal((await unsigned.json()).code, 'bad-request')
    const s = await (await post('/subscribe', { req: await req(ana, { op: 'subscribe', product: PRODUCT }) })).json()
    assert.match(s.approveUrl, /^https:\/\/paypal\.test\//)
    const other = await post('/confirm', { id: s.id, req: await req(beto, { op: 'confirm', id: s.id }) })
    assert.equal(other.status, 404)
    assert.equal((await other.json()).code, 'sub-not-found')
  } finally { server.close() }
})

test('sin PayPal configurado no se vende', async () => {
  const accounts = new Accounts({ store: new Store(), vaults: fakeVaults(), now })
  await assert.rejects(accounts.subscribe({ req: await req(ana, { op: 'subscribe', product: PRODUCT }) }), { code: 'payments-unavailable' })
})

test('una base de antes de la réplica no se abre: se dice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-old-'))
  dirs.push(dir)
  const file = path.join(dir, 'old.db')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE subs (id TEXT PRIMARY KEY, claim TEXT NOT NULL)')
  db.close()
  assert.throws(() => new Store(file), { code: 'old-store' })
})
