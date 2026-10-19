/**
 * Las cuentas: comprar una bóveda alojada, activarla, renovarla (lo hace PayPal cada mes) y
 * apagarla o volverla a encender según lo pagado (`docs/DISENO.md`).
 *
 * Dos reglas que ordenan todo esto:
 *
 *   · LA FUENTE DE VERDAD DEL COBRO ES PAYPAL. Un webhook solo avisa de que hay que mirar: lo
 *     que se apunta sale de preguntarle a PayPal por la suscripción, nunca del cuerpo del aviso.
 *   · LO QUE SE PIDE SOBRE UNA SUSCRIPCIÓN LO FIRMA SU CUENTA. En cuanto la pila da la cuenta
 *     de la bóveda (`Account`, 64 hex), ver y cancelar son peticiones firmadas por un aparato
 *     de esa cuenta. Antes de eso, solo el navegador que compró (su `claim`) ve el código de
 *     activación.
 */
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { priceWithTax } from '@dotrino/pay'
import { verifySignedFor } from '@dotrino/identity/assertion'
import { pubkeyId } from '@dotrino/identity/keyid'

export const AUDIENCE = 'https://accounts.dotrino.com'
export const FORMAT_V = 1
/** $5/mes + IVA (15 % en Ecuador). El plan de PayPal se da de alta con esto (`scripts/setup-plan.mjs`). */
export const PRICE_CENTS = 500
export const TAX_PERCENT = 15
export const PRICE = Object.freeze({ ...priceWithTax({ unitCents: PRICE_CENTS, taxPercent: TAX_PERCENT }), taxPercent: TAX_PERCENT, currency: 'USD', interval: 'month' })
const DAY = 24 * 60 * 60 * 1000
/** Cuánto vale el código de activación: lo que tarda alguien en volver a mirar su correo. */
export const ACTIVATION_MS = 7 * DAY

export class AccountsError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const fail = (code, message) => { throw new AccountsError(code, message) }

const hash = (s) => createHash('sha256').update(String(s)).digest()
const sameClaim = (claim, stored) => typeof claim === 'string' && claim.length >= 32 && timingSafeEqual(hash(claim), Buffer.from(stored, 'hex'))
/** Base32 sin letras que se confundan: el código se puede tener que teclear. */
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const activationCode = () => Array.from(randomBytes(24), (b) => CODE_ABC[b % 32]).join('').replace(/(.{4})(?!$)/g, '$1-')

export class Accounts {
  constructor ({ store, vaults, paypal = null, planId = null, webhookId = null, publicUrl = 'https://accounts.dotrino.com', now = Date.now, log = () => {} }) {
    Object.assign(this, { store, vaults, paypal, planId, webhookId, publicUrl, now, log })
  }

  #payments () {
    if (!this.paypal || !this.planId) fail('payments-unavailable', 'payments are not configured')
    return this.paypal
  }

  #byClaim (id, claim) {
    const row = this.store.get(String(id || ''))
    if (!row || !sameClaim(claim, row.claim)) fail('sub-not-found', 'no such subscription')
    return row
  }

  /** Lo que se enseña de una suscripción. El código de activación, solo a quien compró. */
  view (row, { withActivation = false } = {}) {
    const v = {
      id: row.id, status: row.status, paidThrough: row.paid_through, stack: row.stack,
      login: row.login, account: row.account, on: !!row.vault_on, note: row.note, created: row.created
    }
    if (withActivation && row.activation && row.activation_until > this.now()) Object.assign(v, { activation: row.activation, activationUntil: row.activation_until })
    return v
  }

  /** 1. Empieza la compra: PayPal da el enlace para aprobarla. */
  async subscribe () {
    const paypal = this.#payments()
    const id = randomUUID()
    const claim = randomBytes(32).toString('base64url')
    const { id: paypalId, approveUrl } = await paypal.createSubscription({
      planId: this.planId, customId: id,
      returnUrl: `${this.publicUrl}/subscribed?sub=${id}`, cancelUrl: `${this.publicUrl}/`
    })
    const ts = this.now()
    this.store.insert({ id, claim: hash(claim).toString('hex'), paypal_id: paypalId, status: 'APPROVAL_PENDING', created: ts, updated: ts })
    return { id, claim, approveUrl, price: PRICE }
  }

  /** 2. De vuelta de PayPal: si está activa y es nuestra, se crea la bóveda. Repetirlo no crea otra. */
  async confirm ({ id, claim }) {
    let row = this.#byClaim(id, claim)
    row = await this.refresh(row)
    if (row.status === 'ACTIVE' && row.stack === 'none') row = await this.#provision(row)
    if (row.stack === 'creating') row = await this.progress(row)
    return this.view(row, { withActivation: true })
  }

  /** Lo que pregunta la página mientras se crea la bóveda (tarda unos minutos). */
  async status ({ id, claim }) {
    let row = this.#byClaim(id, claim)
    if (row.stack === 'creating') row = await this.progress(row)
    return this.view(row, { withActivation: true })
  }

  async #provision (row) {
    const vault = 'h' + randomBytes(6).toString('hex')
    const code = activationCode()
    // Se apunta ANTES de crear la pila: si el proceso muere a mitad, la fila dice qué pila
    // buscar, en vez de dejar una bóveda pagada sin dueño.
    this.store.update(row.id, { vault, stack: 'creating', activation: code, activation_until: this.now() + ACTIVATION_MS, updated: this.now() })
    try {
      await this.vaults.create({ vault, adminPassword: code })
    } catch (e) {
      this.store.update(row.id, { stack: 'failed', note: `create: ${e.code || e.name}: ${e.message}`, updated: this.now() })
      this.log(`[accounts] ${row.id}: stack ${vault} not created: ${e.message}`)
      await this.#refund(this.store.get(row.id))
      return this.store.get(row.id)
    }
    this.log(`[accounts] ${row.id}: creating vault ${vault}`)
    return this.store.get(row.id)
  }

  /** Mira cómo va la pila y apunta la cuenta en cuanto la da. */
  async progress (row) {
    const d = await this.vaults.describe(row.vault)
    if (d.state === 'ready') {
      this.store.update(row.id, { stack: 'ready', login: d.login, account: d.account, vault_on: 1, updated: this.now() })
      this.log(`[accounts] ${row.id}: vault ${row.vault} ready as ${d.login}`)
      return this.reconcile(this.store.get(row.id))
    }
    if (d.state === 'failed') {
      this.store.update(row.id, { stack: 'failed', note: d.reason, updated: this.now() })
      this.log(`[accounts] ${row.id}: vault ${row.vault} failed: ${d.reason}`)
      await this.#refund(this.store.get(row.id))
    }
    return this.store.get(row.id)
  }

  /** Sin bóveda no se cobra el mes siguiente: la suscripción se cancela y se dice. */
  async #refund (row) {
    if (!row.paypal_id || !this.paypal) return
    try {
      await this.paypal.cancelSubscription(row.paypal_id, 'the vault could not be created')
      await this.refresh(row)
    } catch (e) { this.log(`[accounts] ${row.id}: could not cancel after a failed vault: ${e.message}`) }
  }

  /** Pregunta a PayPal por la suscripción y apunta lo que diga. Después, enciende o apaga. */
  async refresh (row) {
    const s = await this.#payments().getSubscription(row.paypal_id)
    if (s.customId !== row.id) fail('subscription-mismatch', `subscription ${row.paypal_id} is not ${row.id}`)
    if (s.planId !== this.planId) fail('subscription-mismatch', `subscription ${row.paypal_id} is for plan ${s.planId}`)
    // Cancelada, PayPal ya no dice hasta cuándo está pagada: vale lo que se apuntó mientras lo decía.
    const paidThrough = s.paidThrough ?? row.paid_through
    this.store.update(row.id, { status: s.status, paid_through: paidThrough, updated: this.now() })
    if (s.status !== row.status) this.log(`[accounts] ${row.id}: ${row.status} → ${s.status}`)
    return this.reconcile(this.store.get(row.id))
  }

  /** ¿Tiene que estar encendida? Activa, o pagada hasta una fecha que no ha llegado. */
  shouldBeOn (row) {
    return row.status === 'ACTIVE' || (Number.isFinite(row.paid_through) && this.now() < row.paid_through)
  }

  async reconcile (row) {
    if (row.stack !== 'ready') return row
    const on = this.shouldBeOn(row)
    if (on === !!row.vault_on) return row
    await this.vaults.setOn(row.vault, on)
    this.store.update(row.id, { vault_on: on ? 1 : 0, updated: this.now() })
    this.log(`[accounts] ${row.id}: vault ${row.vault} ${on ? 'turned on' : 'turned off'}`)
    return this.store.get(row.id)
  }

  /** Una petición firmada por un aparato de una cuenta. Devuelve la cuenta (64 hex). */
  async #signed (req, op, extra = {}) {
    if (!req?.body || typeof req.body !== 'object') fail('bad-request', `${op}: no signed request`)
    const now = this.now()
    const v = await verifySignedFor({ data: req.body, signature: req.signature, publickey: req.publickey, chain: req.chain, audience: AUDIENCE, now })
    if (!v.ok) fail('bad-request-signature', `${op}: ${v.reason}`)
    const b = req.body
    if (b.v !== FORMAT_V) fail('bad-version', `${op}: request version ${b.v}`)
    if (b.op !== op) fail('request-mismatch', `${op}: request is for ${b.op}`)
    for (const [k, val] of Object.entries(extra)) if (b[k] !== val) fail('request-mismatch', `${op}: request ${k} differs`)
    if (!Number.isFinite(b.exp) || b.exp < now || b.exp > now + DAY) fail('bad-request', `${op}: request exp out of range`)
    if (typeof b.nonce !== 'string' || b.nonce.length < 16) fail('bad-request', `${op}: request without nonce`)
    if (!this.store.useNonce(b.nonce, b.exp, now)) fail('replayed', `${op}: request already used`)
    return pubkeyId(v.profileId)
  }

  /** Las suscripciones de la cuenta que firma. */
  async mine ({ req }) {
    const account = await this.#signed(req, 'mine')
    return this.store.ofAccount(account).map((r) => this.view(r))
  }

  /** Cancelar: sigue encendida hasta el fin de lo pagado, y entonces se apaga (no se borra). */
  async cancel ({ id, req }) {
    const account = await this.#signed(req, 'cancel', { id })
    const row = this.store.get(String(id))
    if (!row || row.account !== account) fail('sub-not-found', 'no such subscription for this account')
    if (row.status === 'ACTIVE' || row.status === 'SUSPENDED') await this.#payments().cancelSubscription(row.paypal_id)
    return this.view(await this.refresh(row))
  }

  /** Un aviso de PayPal. Se comprueba con PayPal, se apunta una vez, y se mira la suscripción. */
  async webhook ({ headers, raw }) {
    const paypal = this.#payments()
    if (!this.webhookId) fail('payments-unavailable', 'webhook id is not configured')
    let event
    try { event = JSON.parse(raw) } catch (_) { fail('bad-json', 'webhook body is not JSON') }
    if (!await paypal.verifyWebhook({ headers, event, webhookId: this.webhookId })) fail('bad-webhook-signature', 'PayPal did not confirm this webhook')
    const r = event.resource || {}
    const paypalId = event.event_type?.startsWith('BILLING.SUBSCRIPTION.') ? r.id : r.billing_agreement_id
    const row = paypalId ? this.store.byPaypal(paypalId) : null
    const fresh = this.store.addEvent({ id: String(event.id), sub: row?.id ?? null, kind: String(event.event_type), json: raw, ts: this.now() })
    if (!row) { this.log(`[accounts] webhook ${event.event_type} for an unknown subscription ${paypalId}`); return { ok: true } }
    if (fresh) await this.refresh(row)
    return { ok: true }
  }

  /**
   * Lo que corre solo: termina las pilas a medio crear, pregunta a PayPal por cada suscripción
   * (el webhook avisa antes, pero no es la única fuente) y olvida los códigos vencidos.
   * Un fallo en una fila se dice y no para las demás.
   */
  async sweep () {
    let n = 0
    for (const row of this.store.live()) {
      try {
        if (row.activation && row.activation_until <= this.now()) this.store.update(row.id, { activation: null, activation_until: null })
        if (row.stack === 'creating') await this.progress(row)
        if (row.paypal_id && row.status !== 'APPROVAL_PENDING') await this.refresh(this.store.get(row.id))
        n++
      } catch (e) { this.log(`[accounts] sweep ${row.id}: ${e.code || ''} ${e.message}`) }
    }
    return n
  }
}
