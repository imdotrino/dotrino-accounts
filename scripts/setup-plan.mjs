#!/usr/bin/env node
/**
 * Crea en PayPal el producto y el plan mensual de la bóveda alojada, una vez por entorno
 * (sandbox o live), e imprime el `PAYPAL_PLAN_ID` que va al cajón `accounts`.
 *
 *   dotrino-env run --ns accounts -- node scripts/setup-plan.mjs
 *
 * Lee PAYPAL_CLIENT_ID, PAYPAL_SECRET y PAYPAL_LIVE del entorno. El precio es el de
 * `src/accounts.js` (PRICE): no se escribe dos veces.
 */
import { paypalClient } from '../src/paypal.js'
import { PRICE } from '../src/accounts.js'

const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_LIVE } = process.env
const paypal = paypalClient({ clientId: PAYPAL_CLIENT_ID, secret: PAYPAL_SECRET, live: PAYPAL_LIVE === '1' })
const product = await paypal.createProduct({ name: 'Dotrino hosted vault', description: 'A Dotrino vault that runs in the cloud, reachable without a computer on.' })
const plan = await paypal.createPlan({ productId: product.id, name: 'Hosted vault, monthly', price: PRICE.subtotal, taxPercent: PRICE.taxPercent })
console.log(`${paypal.live ? 'live' : 'sandbox'} · product ${product.id}`)
console.log(`PAYPAL_PLAN_ID=${plan.id}`)
