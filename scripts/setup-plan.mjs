#!/usr/bin/env node
/**
 * Crea en PayPal el producto y el plan mensual de la RÉPLICA alojada, una vez por entorno
 * (sandbox o live), e imprime el `PAYPAL_REPLICA_PLAN_ID` que va al cajón `accounts`.
 *
 *   ACCOUNTS_DIR=~/.dotrino-accounts/link node scripts/setup-plan.mjs
 *
 * Las credenciales de PayPal salen del cajón, con la identidad del servicio (la misma que usa
 * `server.js`). El precio es el de `src/accounts.js` (PRICE): no se escribe dos veces.
 */
import { paypalClient } from '@dotrino/pay'
import { PRICE } from '../src/accounts.js'
import { loadServiceIdentity, loadSecrets } from '../src/identity.js'

const s = await loadSecrets(await loadServiceIdentity({ log: () => {} }), { log: () => {} })
const paypal = paypalClient({ clientId: s.PAYPAL_CLIENT_ID, secret: s.PAYPAL_SECRET, live: s.PAYPAL_LIVE === '1' })
const product = await paypal.createProduct({ name: 'Dotrino hosted replica', description: 'A replica of your Dotrino vault in the cloud: your account answers with your computer off.' })
const plan = await paypal.createPlan({ productId: product.id, name: 'Hosted replica, monthly', price: PRICE.subtotal, taxPercent: PRICE.taxPercent })
console.log(`${paypal.live ? 'live' : 'sandbox'} · product ${product.id}`)
console.log(`PAYPAL_REPLICA_PLAN_ID=${plan.id}`)
process.exit(0)
