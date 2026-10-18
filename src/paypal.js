/**
 * PayPal, por la API de SUSCRIPCIONES (Billing v1) y por REDIRECCIÓN: el usuario aprueba en
 * paypal.com y vuelve. En la página no se carga NADA de PayPal (`CLAUDE.md`: nada de JavaScript
 * de terceros).
 *
 * A PayPal le llega el plan y un número de un solo uso (`custom_id`). Ni la cuenta de Dotrino
 * ni nada del usuario.
 *
 * El transporte (token cacheado, errores con `code`) es el mismo que el de
 * `dotrino-names/server/paypal.js`. Deuda declarada: names cobra por su lado; cuando pase a
 * cobrar por este servicio, esa copia se quita (`PENDIENTES.md`).
 */
const BASES = { live: 'https://api-m.paypal.com', sandbox: 'https://api-m.sandbox.paypal.com' }
const SUB_ID = /^I-[A-Z0-9]{6,40}$/

export function paypalClient ({ clientId, secret, live = false, fetch = globalThis.fetch }) {
  if (!clientId || !secret) throw new Error('paypal: clientId and secret are required')
  const base = live ? BASES.live : BASES.sandbox
  let token = null

  async function call (path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` }
    const res = await fetch(base + path, { method, headers, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (_) { data = { raw: text } }
    if (!res.ok) {
      const issue = data?.details?.[0]?.issue || null
      throw Object.assign(new Error(`paypal ${method} ${path}: ${res.status} ${issue || data?.name || ''} ${data?.message || ''}`.trim()), { code: res.status === 404 ? 'paypal-not-found' : 'paypal-error', issue, status: res.status })
    }
    return data
  }

  async function accessToken () {
    if (token && token.until > Date.now()) return token.value
    const auth = 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64')
    const res = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.access_token) throw Object.assign(new Error(`paypal token: ${res.status}`), { code: 'paypal-error', status: res.status })
    token = { value: data.access_token, until: Date.now() + Math.max(0, (data.expires_in - 60) * 1000) }
    return token.value
  }

  const checkId = (id) => { if (!SUB_ID.test(id)) throw Object.assign(new Error('paypal: bad subscription id'), { code: 'bad-subscription' }) }

  return {
    live,
    /** @returns {Promise<{ id:string, approveUrl:string }>} */
    async createSubscription ({ planId, customId, returnUrl, cancelUrl }) {
      const data = await call('/v1/billing/subscriptions', {
        method: 'POST',
        body: {
          plan_id: planId,
          custom_id: customId,
          application_context: { brand_name: 'Dotrino', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl }
        }
      })
      const approveUrl = (data.links || []).find((l) => l.rel === 'approve')?.href
      if (!data.id || !approveUrl) throw Object.assign(new Error('paypal: subscription without approval link'), { code: 'paypal-error' })
      return { id: data.id, approveUrl }
    },

    /**
     * Lo que importa de una suscripción. `paidThrough` es hasta cuándo está pagada: el próximo
     * cobro mientras está activa. Cancelada, PayPal ya no lo da, y el que vale es el que se
     * guardó antes.
     * @returns {Promise<{ id, status, planId, customId, paidThrough:number|null }>}
     */
    async getSubscription (id) {
      checkId(id)
      const d = await call(`/v1/billing/subscriptions/${id}`)
      const next = d.billing_info?.next_billing_time ? Date.parse(d.billing_info.next_billing_time) : null
      return { id: d.id, status: d.status, planId: d.plan_id, customId: d.custom_id ?? null, paidThrough: Number.isFinite(next) ? next : null }
    },

    async cancelSubscription (id, reason = 'cancelled by the account') {
      checkId(id)
      await call(`/v1/billing/subscriptions/${id}/cancel`, { method: 'POST', body: { reason } })
    },

    /**
     * ¿Este webhook lo mandó PayPal? Lo dice PayPal (`verify-webhook-signature`), con las
     * cabeceras de la petición y el cuerpo tal cual llegó.
     */
    async verifyWebhook ({ headers, event, webhookId }) {
      const h = (k) => headers[k] || headers[k.toLowerCase()]
      const d = await call('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: {
          auth_algo: h('paypal-auth-algo'),
          cert_url: h('paypal-cert-url'),
          transmission_id: h('paypal-transmission-id'),
          transmission_sig: h('paypal-transmission-sig'),
          transmission_time: h('paypal-transmission-time'),
          webhook_id: webhookId,
          webhook_event: event
        }
      })
      return d?.verification_status === 'SUCCESS'
    },

    /** Para `scripts/setup-webhook.mjs`: el webhook de la app, una vez por entorno. */
    async createWebhook ({ url, eventTypes }) {
      return call('/v1/notifications/webhooks', { method: 'POST', body: { url, event_types: eventTypes.map((name) => ({ name })) } })
    },
    async listWebhooks () { return (await call('/v1/notifications/webhooks')).webhooks || [] },

    /** Para `scripts/setup-plan.mjs`: el producto y el plan, una vez por entorno. */
    async createProduct ({ name, description }) {
      return call('/v1/catalogs/products', { method: 'POST', body: { name, description, type: 'SERVICE', category: 'SOFTWARE' } })
    },
    async createPlan ({ productId, name, price, taxPercent }) {
      return call('/v1/billing/plans', {
        method: 'POST',
        body: {
          product_id: productId,
          name,
          billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: price, currency_code: 'USD' } } }],
          payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
          taxes: { percentage: taxPercent, inclusive: false }
        }
      })
    }
  }
}
