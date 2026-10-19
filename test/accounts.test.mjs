/**
 * El servicio de punta a punta, sin red: identidades de Node reales, un PayPal fingido y unas
 * pilas fingidas. Lo que se prueba es lo que decide el servicio: crear UNA bóveda por compra,
 * atarla a la cuenta que da la pila, dejar que solo esa cuenta la cancele, y encenderla o
 * apagarla según lo que diga PayPal (no lo que diga un aviso).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Identity } from '@dotrino/identity/node'
import { pubkeyId } from '@dotrino/identity/keyid'
import { Store } from '../src/store.js'
import { Accounts, AUDIENCE, FORMAT_V } from '../src/accounts.js'
import { makeHandler } from '../src/http.js'

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

function fakeVaults (owner) {
  const stacks = new Map()
  return {
    stacks,
    async create ({ vault, adminPassword }) { stacks.set(vault, { state: 'creating', adminPassword, on: true }) },
    async describe (vault) {
      const s = stacks.get(vault)
      return s.state === 'ready' ? { state: 'ready', login: 'admin@AB12-CD34-EF56', account: owner().account } : { state: s.state, reason: s.reason }
    },
    async setOn (vault, on) { stacks.get(vault).on = on },
    finish (vault) { stacks.get(vault).state = 'ready' }
  }
}

let ana, beto
test.before(async () => { ;[ana, beto] = await Promise.all([account(), account()]) })
test.after(() => { for (const id of ids) id.destroy?.(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function setup () {
  const paypal = fakePaypal()
  const vaults = fakeVaults(() => ana)
  const accounts = new Accounts({ store: new Store(), vaults, paypal, planId: PLAN, webhookId: 'WH-1', now })
  return { paypal, vaults, accounts }
}

/** Compra, aprueba en PayPal, confirma y deja la pila lista. */
async function bought ({ paypal, vaults, accounts }) {
  const { id, claim } = await accounts.subscribe()
  paypal.approve(accounts.store.get(id).paypal_id)
  const c = await accounts.confirm({ id, claim })
  const vault = accounts.store.get(id).vault
  vaults.finish(vault)
  const ready = await accounts.status({ id, claim })
  return { id, claim, vault, c, ready }
}

test('comprar: sin aprobar no hay bóveda; aprobada se crea UNA, y el código lo ve solo quien compró', async () => {
  const t = setup()
  const { id, claim } = await t.accounts.subscribe()
  const pending = await t.accounts.confirm({ id, claim })
  assert.equal(pending.status, 'APPROVAL_PENDING')
  assert.equal(t.vaults.stacks.size, 0)

  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  const c = await t.accounts.confirm({ id, claim })
  assert.equal(c.stack, 'creating')
  assert.match(c.activation, /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/)
  await t.accounts.confirm({ id, claim })
  assert.equal(t.vaults.stacks.size, 1, 'confirmar dos veces no crea otra bóveda')
  const [vault] = t.vaults.stacks.keys()
  assert.equal(t.vaults.stacks.get(vault).adminPassword, c.activation)

  await assert.rejects(t.accounts.status({ id, claim: 'x'.repeat(43) }), { code: 'sub-not-found' })

  t.vaults.finish(vault)
  const ready = await t.accounts.status({ id, claim })
  assert.equal(ready.stack, 'ready')
  assert.equal(ready.account, ana.account)
  assert.equal(ready.on, true)

  clock += 8 * DAY
  await t.accounts.sweep()
  assert.equal((await t.accounts.status({ id, claim })).activation, undefined, 'el código caduca')
  clock -= 8 * DAY
})

test('una suscripción de otro plan o de otra compra no crea nada', async () => {
  const t = setup()
  const { id, claim } = await t.accounts.subscribe()
  const sub = t.paypal.subs.get(t.accounts.store.get(id).paypal_id)
  t.paypal.approve(sub.id)
  sub.planId = 'P-OTHER'
  await assert.rejects(t.accounts.confirm({ id, claim }), { code: 'subscription-mismatch' })
  sub.planId = PLAN
  sub.customId = randomUUID()
  await assert.rejects(t.accounts.confirm({ id, claim }), { code: 'subscription-mismatch' })
  assert.equal(t.vaults.stacks.size, 0)
})

test('si la pila falla, no se cobra el mes siguiente: la suscripción se cancela', async () => {
  const t = setup()
  const { id, claim } = await t.accounts.subscribe()
  t.paypal.approve(t.accounts.store.get(id).paypal_id)
  await t.accounts.confirm({ id, claim })
  const [vault] = t.vaults.stacks.keys()
  Object.assign(t.vaults.stacks.get(vault), { state: 'failed', reason: 'ROLLBACK_COMPLETE' })
  const v = await t.accounts.status({ id, claim })
  assert.equal(v.stack, 'failed')
  assert.equal(v.status, 'CANCELLED')
})

test('si la pila falla, el primer mes se devuelve, aunque PayPal lo apunte después', async () => {
  const t = setup()
  const { id, claim } = await t.accounts.subscribe()
  const pid = t.accounts.store.get(id).paypal_id
  t.paypal.approve(pid)
  await t.accounts.confirm({ id, claim })
  const [vault] = t.vaults.stacks.keys()
  Object.assign(t.vaults.stacks.get(vault), { state: 'failed', reason: 'ROLLBACK_COMPLETE' })
  await t.accounts.status({ id, claim })
  assert.equal(t.accounts.store.get(id).refund, 'pending', 'todavía no hay cobro que devolver')
  t.paypal.payments.set(pid, [{ id: 'CAP0000001', status: 'COMPLETED', amount: '5.75' }])
  await t.accounts.sweep()
  assert.deepEqual(t.paypal.refunds, ['CAP0000001'])
  assert.equal(t.accounts.store.get(id).refund, 'done')
  await t.accounts.sweep()
  assert.deepEqual(t.paypal.refunds, ['CAP0000001'], 'no se devuelve dos veces')
})

test('la cuenta de la bóveda ve y cancela la suya; otra cuenta no', async () => {
  const t = setup()
  const { id, vault } = await bought(t)
  const mine = await t.accounts.mine({ req: await req(ana, { op: 'mine' }) })
  assert.deepEqual(mine.map((s) => s.id), [id])
  assert.equal(mine[0].activation, undefined, 'el código no sale por aquí')
  assert.deepEqual(await t.accounts.mine({ req: await req(beto, { op: 'mine' }) }), [])

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

test('por HTTP: precio, compra y errores con su código', async () => {
  const t = setup()
  const server = http.createServer(makeHandler({ accounts: t.accounts, version: '0.1.0' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await (await fetch(base + '/price')).json()).total, '5.75')
    const s = await (await fetch(base + '/subscribe', { method: 'POST' })).json()
    assert.match(s.approveUrl, /^https:\/\/paypal\.test\//)
    const bad = await fetch(base + '/status', { method: 'POST', body: JSON.stringify({ id: s.id, claim: 'nope' }) })
    assert.equal(bad.status, 404)
    assert.equal((await bad.json()).code, 'sub-not-found')
  } finally { server.close() }
})

test('sin PayPal configurado no se vende', async () => {
  const accounts = new Accounts({ store: new Store(), vaults: fakeVaults(() => ana), now })
  await assert.rejects(accounts.subscribe(), { code: 'payments-unavailable' })
})
