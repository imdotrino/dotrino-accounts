/**
 * Las cuentas: comprar una RÉPLICA alojada para la cuenta que ya tienes, enrolarla con tu
 * invitación, renovarla (lo hace PayPal cada mes) y apagarla o volverla a encender según lo
 * pagado (`docs/DISENO.md` §8.bis y §9).
 *
 * Tres reglas que ordenan todo esto:
 *
 *   · LA FUENTE DE VERDAD DEL COBRO ES PAYPAL. Un webhook solo avisa de que hay que mirar: lo
 *     que se apunta sale de preguntarle a PayPal por la suscripción, nunca del cuerpo del aviso.
 *   · TODO LO PIDE LA CUENTA, FIRMADO. Comprar, confirmar, enrolar, ver y cancelar son
 *     peticiones firmadas por un aparato de la cuenta del cliente: la réplica es de esa cuenta
 *     desde el primer momento, y se administra desde el perfil que ya usa.
 *   · NADA ENTRA AL ACTA SIN INVITACIÓN. La réplica nace vacía y solo se enrola con la
 *     invitación que saca el dueño en su bóveda y el código que aprueba allí.
 */
import { randomUUID, randomBytes } from 'node:crypto'
import { priceWithTax } from '@dotrino/pay'
import { verifySignedFor } from '@dotrino/identity/assertion'
import { pubkeyId } from '@dotrino/identity/keyid'

export const AUDIENCE = 'https://accounts.dotrino.com'
export const FORMAT_V = 1
export const PRODUCT = 'replica'
/** $3/mes + IVA (15 % en Ecuador). El plan de PayPal se da de alta con esto (`scripts/setup-plan.mjs`). */
export const PRICE_CENTS = 300
export const TAX_PERCENT = 15
export const PRICE = Object.freeze({ ...priceWithTax({ unitCents: PRICE_CENTS, taxPercent: TAX_PERCENT }), taxPercent: TAX_PERCENT, currency: 'USD', interval: 'month', product: PRODUCT })
const DAY = 24 * 60 * 60 * 1000
/** Cuánto se espera a que PayPal apunte el primer cobro antes de dar por hecho que no lo hubo. */
/** El estado de una réplica que añadió el administrador a una cuenta: sin suscripción ni cobro. */
export const COMP = 'COMP'
export const REFUND_WAIT_MS = 3 * DAY
/** Una réplica pagada que nadie enroló en este tiempo se borra y se devuelve lo cobrado. */
export const ENROLL_WITHIN_MS = DAY
/** Cada cuánto, como mucho, se le pregunta a una réplica sin enrolar si ya lo está. */
const STATUS_EVERY_MS = 10_000

export class AccountsError extends Error {
  constructor (code, message) { super(message); this.code = code }
}
const fail = (code, message) => { throw new AccountsError(code, message) }

export class Accounts {
  /**
   * `shopUrl`: la página donde se compra, que es la de la BÓVEDA (`vault.dotrino.com/hosted`).
   * Allí vuelve PayPal (`?sub=<id>`) y desde allí se enrola.
   */
  constructor ({ store, vaults, paypal = null, planId = null, webhookId = null, shopUrl = 'https://vault.dotrino.com/hosted', now = Date.now, log = () => {} }) {
    Object.assign(this, { store, vaults, paypal, planId, webhookId, shopUrl, now, log })
    this.lastStatus = new Map()
  }

  #payments () {
    if (!this.paypal || !this.planId) fail('payments-unavailable', 'payments are not configured')
    return this.paypal
  }

  /** La fila, si es de la cuenta que firma. Otra cuenta no sabe ni que existe. */
  #ofAccount (id, account) {
    const row = this.store.get(String(id || ''))
    if (!row || row.account !== account) fail('sub-not-found', 'no such subscription for this account')
    return row
  }

  /** Lo que se enseña de una suscripción. */
  view (row) {
    return {
      id: row.id, product: row.product, status: row.status, paidThrough: row.paid_through,
      stack: row.stack, enrolled: !!row.enrolled, device: row.device, on: !!row.vault_on,
      note: row.note, created: row.created, enrollBefore: row.enrolled ? null : row.created + ENROLL_WITHIN_MS
    }
  }

  /** 1. Empieza la compra, firmada por la cuenta: PayPal da el enlace para aprobarla. */
  async subscribe ({ req }) {
    const account = await this.#signed(req, 'subscribe', { product: PRODUCT })
    const paypal = this.#payments()
    const id = randomUUID()
    const { id: paypalId, approveUrl } = await paypal.createSubscription({
      planId: this.planId, customId: id,
      returnUrl: `${this.shopUrl}?sub=${id}`, cancelUrl: this.shopUrl
    })
    const ts = this.now()
    this.store.insert({ id, account, product: PRODUCT, paypal_id: paypalId, status: 'APPROVAL_PENDING', created: ts, updated: ts })
    return { id, approveUrl, price: PRICE }
  }

  /** 2. De vuelta de PayPal: si está activa, se crea la réplica (vacía). Repetirlo no crea otra. */
  async confirm ({ id, req }) {
    const account = await this.#signed(req, 'confirm', { id })
    let row = await this.refresh(this.#ofAccount(id, account))
    if (row.status === 'ACTIVE' && row.stack === 'none') row = await this.#provision(row)
    if (row.stack === 'creating') row = await this.progress(row)
    return this.view(row)
  }

  /**
   * 3. ENROLARLA con la invitación que el dueño sacó en su bóveda. Devuelve el código que tiene
   * que aprobar allí. Si no lo aprueba a tiempo, se repite con otra invitación.
   */
  async enroll ({ id, invitation, req }) {
    const account = await this.#signed(req, 'enroll', { id })
    let row = this.#ofAccount(id, account)
    if (row.stack === 'creating') row = await this.progress(row)
    if (row.stack !== 'ready') fail('not-ready', `the replica is ${row.stack}, not ready to be enrolled`)
    if (row.enrolled) fail('already-enrolled', 'this replica is already in the account')
    if (typeof invitation !== 'string' || !invitation.trim() || invitation.length > 4096) fail('bad-request', 'enroll: no invitation')
    const r = await this.vaults.invoke(row.vault, { kind: 'enroll', invitation: invitation.trim() })
    if (!r?.ok) fail(r?.error || 'enroll-failed', `enroll: ${r?.message || r?.error || 'the replica could not start the enrollment'}`)
    this.store.update(row.id, { device: r.deviceId, updated: this.now() })
    this.log(`[accounts] ${row.id}: replica ${row.vault} waiting for code approval as ${r.deviceId}`)
    return { ...this.view(this.store.get(row.id)), code: r.code }
  }

  /** ¿Ya la aprobó? Se le pregunta a la réplica, como mucho cada pocos segundos. */
  async #checkEnrolled (row) {
    if (row.stack !== 'ready' || row.enrolled) return row
    if (this.now() - (this.lastStatus.get(row.id) || 0) < STATUS_EVERY_MS) return row
    this.lastStatus.set(row.id, this.now())
    const st = await this.vaults.invoke(row.vault, { kind: 'status' })
    if (!st?.ok) { this.log(`[accounts] ${row.id}: replica status failed: ${st?.error} ${st?.message || ''}`); return row }
    if (!st.enrolled) return row
    this.store.update(row.id, { enrolled: 1, device: st.deviceId, updated: this.now() })
    this.log(`[accounts] ${row.id}: replica ${row.vault} enrolled as ${st.deviceId}`)
    return this.store.get(row.id)
  }

  async #provision (row) {
    const vault = 'h' + randomBytes(6).toString('hex')
    // Se apunta ANTES de crear la pila: si el proceso muere a mitad, la fila dice qué pila
    // buscar, en vez de dejar una réplica pagada sin dueño.
    this.store.update(row.id, { vault, stack: 'creating', updated: this.now() })
    try {
      await this.vaults.create({ vault, owner: row.account })
    } catch (e) {
      this.store.update(row.id, { stack: 'failed', note: `create: ${e.code || e.name}: ${e.message}`, updated: this.now() })
      this.log(`[accounts] ${row.id}: stack ${vault} not created: ${e.message}`)
      await this.#giveBack(this.store.get(row.id), 'the replica could not be created')
      return this.store.get(row.id)
    }
    this.log(`[accounts] ${row.id}: creating replica ${vault}`)
    return this.store.get(row.id)
  }

  /** Mira cómo va la pila. */
  async progress (row) {
    const d = await this.vaults.describe(row.vault)
    if (d.state === 'ready') {
      this.store.update(row.id, { stack: 'ready', vault_on: 1, updated: this.now() })
      this.log(`[accounts] ${row.id}: replica ${row.vault} ready, waiting for its owner to enroll it`)
      return this.reconcile(this.store.get(row.id))
    }
    if (d.state === 'failed') {
      this.store.update(row.id, { stack: 'failed', note: d.reason, updated: this.now() })
      this.log(`[accounts] ${row.id}: replica ${row.vault} failed: ${d.reason}`)
      await this.#giveBack(this.store.get(row.id), 'the replica could not be created')
    }
    return this.store.get(row.id)
  }

  /**
   * NADIE LA ENROLÓ A TIEMPO: no se deja corriendo ni cobrándose. Se cancela, se devuelve lo
   * cobrado y se borra la pila (el bucket se queda, vacío de cuenta: no cuesta).
   */
  async #expire (row) {
    this.log(`[accounts] ${row.id}: replica ${row.vault} was not enrolled within ${ENROLL_WITHIN_MS / 3600000} h: removing it`)
    await this.#giveBack(row, 'the replica was not enrolled in time')
    await this.vaults.remove(row.vault)
    this.store.update(row.id, { stack: 'deleted', vault_on: 0, note: 'not enrolled in time', updated: this.now() })
  }

  /** Sin réplica no se cobra: la suscripción se cancela y lo que ya se cobró se devuelve. */
  async #giveBack (row, reason) {
    if (!row.paypal_id || !this.paypal) return
    try {
      await this.paypal.cancelSubscription(row.paypal_id, reason)
      await this.refresh(row)
    } catch (e) { this.log(`[accounts] ${row.id}: could not cancel (${reason}): ${e.message}`) }
    this.store.update(row.id, { refund: 'pending', updated: this.now() })
    try {
      await this.settleRefund(this.store.get(row.id))
    } catch (e) { this.log(`[accounts] ${row.id}: refund not done yet: ${e.code || ''} ${e.message}`) }
  }

  /**
   * Devuelve lo cobrado a una suscripción sin réplica. PayPal apunta el primer cobro unos
   * minutos después de aprobar, así que justo al fallar puede no haber nada que devolver
   * todavía: queda 'pending' y el barrido lo vuelve a mirar.
   */
  async settleRefund (row) {
    const pays = await this.#payments().subscriptionPayments(row.paypal_id, { since: row.created - DAY, until: this.now() })
    const due = pays.filter((p) => p.status === 'COMPLETED')
    for (const p of due) {
      const r = await this.paypal.refundCapture(p.id, { note: 'Your replica could not be set up.' })
      this.log(`[accounts] ${row.id}: refunded ${p.amount} (${p.id} → ${r.id} ${r.status})`)
    }
    if (due.length || pays.some((p) => p.status === 'REFUNDED')) this.store.update(row.id, { refund: 'done', updated: this.now() })
    else if (this.now() - row.created > REFUND_WAIT_MS) {
      this.store.update(row.id, { refund: 'none', updated: this.now() })
      this.log(`[accounts] ${row.id}: nothing was charged, nothing to refund`)
    }
    return this.store.get(row.id)
  }

  async refresh (row) {
    // Una réplica que añadió el administrador no tiene suscripción: no hay nada que preguntar.
    if (!row.paypal_id) fail('no-subscription', `${row.id} has no PayPal subscription (status ${row.status})`)
    const s = await this.#payments().getSubscription(row.paypal_id)
    if (s.customId !== row.id) fail('subscription-mismatch', `subscription ${row.paypal_id} is not ${row.id}`)
    if (s.planId !== this.planId) fail('subscription-mismatch', `subscription ${row.paypal_id} is for plan ${s.planId}`)
    // Cancelada, PayPal ya no dice hasta cuándo está pagada: vale lo que se apuntó mientras lo decía.
    const paidThrough = s.paidThrough ?? row.paid_through
    this.store.update(row.id, { status: s.status, paid_through: paidThrough, updated: this.now() })
    if (s.status !== row.status) this.log(`[accounts] ${row.id}: ${row.status} → ${s.status}`)
    return this.reconcile(this.store.get(row.id))
  }

  /**
   * ¿Tiene que estar encendida? Si el administrador la encendió o la apagó a mano, eso; si no,
   * activa, sin cargo (la añadió el administrador), o pagada hasta una fecha que no ha llegado.
   */
  shouldBeOn (row) {
    if (row.admin_on === 0 || row.admin_on === 1) return row.admin_on === 1
    return row.status === 'ACTIVE' || row.status === COMP || (Number.isFinite(row.paid_through) && this.now() < row.paid_through)
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
    const out = []
    for (let row of this.store.ofAccount(account)) {
      try {
        if (row.stack === 'creating') row = await this.progress(row)
        row = await this.#checkEnrolled(row)
      } catch (e) { this.log(`[accounts] mine ${row.id}: ${e.code || ''} ${e.message}`) }
      out.push(this.view(row))
    }
    return out
  }

  /** Cancelar: sigue encendida hasta el fin de lo pagado, y entonces se apaga (no se borra). */
  async cancel ({ id, req }) {
    const account = await this.#signed(req, 'cancel', { id })
    const row = this.#ofAccount(id, account)
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
   * Lo que corre solo: termina las pilas a medio crear, borra las réplicas que nadie enroló a
   * tiempo, reintenta las devoluciones y pregunta a PayPal por cada suscripción (el webhook
   * avisa antes, pero no es la única fuente). Un fallo en una fila se dice y no para las demás.
   */
  async sweep () {
    let n = 0
    for (let row of this.store.live()) {
      try {
        if (row.stack === 'creating') row = await this.progress(row)
        if (row.stack === 'ready' && !row.enrolled) {
          row = await this.#checkEnrolled(row)
          if (!row.enrolled && this.now() - row.created > ENROLL_WITHIN_MS) { await this.#expire(row); n++; continue }
        }
        if (row.refund === 'pending') await this.settleRefund(row)
        if (row.paypal_id && row.status !== 'APPROVAL_PENDING') await this.refresh(this.store.get(row.id))
        n++
      } catch (e) { this.log(`[accounts] sweep ${row.id}: ${e.code || ''} ${e.message}`) }
    }
    return n
  }

  // ───────────────────────── Administración (§10) ─────────────────────────
  //
  // Lo pide un aparato de la cuenta de DOTRINO con `admin` en su acta, por la sesión cifrada
  // de `@dotrino/remote-agent` (`src/admin.js` lo comprueba en cada petición). Aquí ya llega
  // decidido: `by` es el ID de ese aparato, para la bitácora.

  /** Lo que ve el administrador de una fila: lo del cliente y además de quién es y qué la sostiene. */
  adminView (row) {
    return { ...this.view(row), account: row.account, vault: row.vault, paypalId: row.paypal_id, refund: row.refund, adminOn: row.admin_on === null ? null : !!row.admin_on }
  }

  #adminRow (id) {
    const row = this.store.get(String(id || ''))
    if (!row) fail('sub-not-found', `no subscription ${id}`)
    return row
  }

  /** Todas las suscripciones y réplicas del servicio, de todas las cuentas. */
  async adminList ({ by }) {
    const rows = this.store.all()
    this.log(`[accounts] admin ${by}: list (${rows.length})`)
    return rows.map((r) => this.adminView(r))
  }

  /**
   * Encender o apagar a mano. `on: true|false` fija el interruptor y pasa por encima del pago;
   * `on: null` lo suelta y vuelve a mandar el pago.
   */
  async adminSetOn ({ id, on, by }) {
    if (on !== true && on !== false && on !== null) fail('bad-request', 'setOn: on must be true, false or null')
    const row = this.#adminRow(id)
    if (row.stack !== 'ready') fail('not-ready', `the replica is ${row.stack}, it cannot be turned on or off`)
    this.store.update(row.id, { admin_on: on === null ? null : on ? 1 : 0, updated: this.now() })
    this.log(`[accounts] admin ${by}: ${row.id} switch ${on === null ? 'released (follows payment)' : on ? 'forced on' : 'forced off'}`)
    return this.adminView(await this.reconcile(this.store.get(row.id)))
  }

  /** Devuelve el ÚLTIMO cobro de la suscripción. No la cancela: eso es otra decisión. */
  async adminRefund ({ id, by }) {
    const row = this.#adminRow(id)
    if (!row.paypal_id) fail('no-subscription', `${row.id} has no PayPal subscription: nothing to refund`)
    const pays = await this.#payments().subscriptionPayments(row.paypal_id, { since: row.created - DAY, until: this.now() })
    const last = pays.filter((p) => p.status === 'COMPLETED').sort((a, b) => b.time - a.time)[0]
    if (!last) fail('nothing-to-refund', `${row.id}: no completed payment to refund`)
    const r = await this.paypal.refundCapture(last.id, { note: 'Refund from Dotrino.' })
    this.store.update(row.id, { refund: 'done', updated: this.now() })
    this.log(`[accounts] admin ${by}: ${row.id} refunded ${last.amount} (${last.id} → ${r.id} ${r.status})`)
    // DEVOLVER TAMBIÉN CANCELA (dueño, 2026-10-19): no se sigue cobrando lo que se devolvió. La
    // réplica sigue hasta el fin de lo pagado y se apaga, como cualquier cancelación.
    if (row.status === 'ACTIVE' || row.status === 'SUSPENDED') {
      await this.#payments().cancelSubscription(row.paypal_id, 'refunded by the administrator')
      await this.refresh(this.store.get(row.id))
      this.log(`[accounts] admin ${by}: ${row.id} subscription cancelled after the refund`)
    }
    return { ...this.adminView(this.store.get(row.id)), refunded: { capture: last.id, amount: last.amount, refund: r.id, status: r.status } }
  }

  /**
   * Añade una réplica a la cuenta `account` (el `pubkeyId` de la llave de su perfil, 64 hex),
   * sin cargo. Nace con `Owner` = esa cuenta, como una comprada, y el cliente la enrola desde
   * su página con su invitación y su código: aquí no se ata a nada más.
   */
  async adminAddReplica ({ account, by }) {
    if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account)) fail('bad-account', 'addReplica: account must be 64 lowercase hex (the pubkeyId of the profile key)')
    const id = randomUUID()
    const ts = this.now()
    this.store.insert({ id, account, product: PRODUCT, status: COMP, created: ts, updated: ts })
    this.log(`[accounts] admin ${by}: ${id} replica added to account ${account.slice(0, 16)}… (no charge)`)
    return this.adminView(await this.#provision(this.store.get(id)))
  }

  /**
   * Borra la réplica (la pila). Si tenía una suscripción viva se cancela antes, para que no se
   * siga cobrando algo que ya no existe; devolver es aparte (`adminRefund`).
   */
  async adminRemove ({ id, by }) {
    const row = this.#adminRow(id)
    if (row.stack === 'deleted') fail('already-deleted', `${row.id}: the replica is already deleted`)
    if (row.stack === 'none' || !row.vault) fail('no-stack', `${row.id}: no replica was ever created`)
    if (row.paypal_id && (row.status === 'ACTIVE' || row.status === 'SUSPENDED')) {
      await this.#payments().cancelSubscription(row.paypal_id, 'removed by the administrator')
      await this.refresh(row)
    }
    await this.vaults.remove(row.vault)
    this.store.update(row.id, { stack: 'deleted', vault_on: 0, note: 'removed by admin', updated: this.now() })
    this.log(`[accounts] admin ${by}: ${row.id} replica ${row.vault} removed`)
    return this.adminView(this.store.get(row.id))
  }
}
