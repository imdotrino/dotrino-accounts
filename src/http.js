/**
 * La cara HTTP del servicio. JSON, sin sesiones ni cookies.
 *
 *   GET  /version                  { product, version, protocol }
 *   GET  /price                    lo que cuesta al mes
 *   POST /subscribe                → { id, claim, approveUrl, price }   (el navegador guarda id y claim)
 *   POST /confirm   { id, claim }  de vuelta de PayPal: crea la bóveda si está pagada
 *   POST /status    { id, claim }  cómo va (y el código de activación, solo a quien compró)
 *   POST /mine      { req }        las suscripciones de la cuenta que firma
 *   POST /cancel    { id, req }    cancelar (firmado por la cuenta de la bóveda)
 *   POST /paypal/webhook           los avisos de PayPal (se comprueban con PayPal)
 *
 * Los errores van con su `code` (el contrato), nunca solo con la frase.
 */
import { AccountsError, PRICE } from './accounts.js'

export const PROTOCOL = 1
const MAX_BODY = 256 * 1024

const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > MAX_BODY) { reject(new AccountsError('body-too-large', 'body too large')); req.destroy() } })
  req.on('end', () => resolve(b))
  req.on('error', reject)
})
const parse = (raw) => { try { return raw ? JSON.parse(raw) : {} } catch (_) { throw new AccountsError('bad-json', 'body is not JSON') } }

const STATUS = {
  'sub-not-found': 404, 'stack-not-found': 404, 'not-found': 404,
  'bad-request': 400, 'bad-json': 400, 'bad-version': 400, 'request-mismatch': 400,
  'bad-request-signature': 401, 'bad-webhook-signature': 401, 'replayed': 409, 'subscription-mismatch': 409,
  'payments-unavailable': 503, 'provider-error': 502, 'provider-not-found': 502, 'payment-declined': 402, 'bad-id': 400, 'body-too-large': 413
}

export function makeHandler ({ accounts, version, product = '@dotrino/accounts-server', log = () => {} }) {
  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' })
    res.end(JSON.stringify(obj))
  }
  const routes = {
    'POST /subscribe': () => accounts.subscribe(),
    'POST /confirm': (b) => accounts.confirm({ id: b.id, claim: b.claim }),
    'POST /status': (b) => accounts.status({ id: b.id, claim: b.claim }),
    'POST /mine': (b) => accounts.mine({ req: b.req }),
    'POST /cancel': (b) => accounts.cancel({ id: b.id, req: b.req })
  }

  return async function handle (req, res) {
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/'
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {})
      if (req.method === 'GET') {
        if (path === '/version') return json(res, 200, { product, version, protocol: PROTOCOL })
        if (path === '/price') return json(res, 200, PRICE)
        // La compra se hace en la página de la bóveda: aquí solo está la API.
        if (path === '/') { res.writeHead(302, { location: 'https://vault.dotrino.com/hosted' }); return res.end() }
        return json(res, 404, { code: 'not-found' })
      }
      if (req.method === 'POST') {
        const raw = await readBody(req)
        if (path === '/paypal/webhook') return json(res, 200, await accounts.webhook({ headers: req.headers, raw }))
        const fn = routes[`POST ${path}`]
        if (!fn) return json(res, 404, { code: 'not-found' })
        return json(res, 200, await fn(parse(raw)))
      }
      return json(res, 405, { code: 'method-not-allowed' })
    } catch (e) {
      const code = e?.code || 'internal'
      if (!STATUS[code]) log(`[accounts] ${req.method} ${path}: ${e?.stack || e}`)
      return json(res, STATUS[code] || 500, { code, error: STATUS[code] ? e.message : 'internal error' })
    }
  }
}
