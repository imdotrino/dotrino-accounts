#!/usr/bin/env node
/**
 * Crea en PayPal el producto y el plan mensual de lo que se vende (`replica` o `vault`), una vez
 * por entorno (sandbox o live), e imprime la variable que va al cajón `accounts`.
 *
 *   ACCOUNTS_DIR=~/.dotrino-accounts/link node scripts/setup-plan.mjs [replica|vault]
 *
 * Las credenciales de PayPal salen del cajón, con la identidad del servicio (la misma que usa
 * `server.js`). El precio es el de `src/accounts.js` (PRODUCTS): no se escribe dos veces.
 */
import { paypalClient } from '@dotrino/pay'
import { Accounts, PRODUCTS, priceOf } from '../src/accounts.js'
import { loadServiceIdentity, loadSecrets } from '../src/identity.js'

const which = Accounts.product(process.argv[2] || 'replica')
const s = await loadSecrets(await loadServiceIdentity({ log: () => {} }), { log: () => {} })
const paypal = paypalClient({ clientId: s.PAYPAL_CLIENT_ID, secret: s.PAYPAL_SECRET, live: s.PAYPAL_LIVE === '1' })
const price = priceOf(which)
const product = await paypal.createProduct({ name: PRODUCTS[which].name, description: PRODUCTS[which].description })
const plan = await paypal.createPlan({ productId: product.id, name: `${PRODUCTS[which].name.replace(/^Dotrino h/, 'H')}, monthly`, price: price.subtotal, taxPercent: price.taxPercent })
console.log(`${paypal.live ? 'live' : 'sandbox'} · product ${product.id}`)
console.log(`PAYPAL_${which.toUpperCase()}_PLAN_ID=${plan.id}`)
process.exit(0)
