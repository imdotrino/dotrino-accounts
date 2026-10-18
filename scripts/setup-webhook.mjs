#!/usr/bin/env node
/**
 * Registra en PayPal el webhook del servicio, una vez por entorno (sandbox o live), e
 * imprime el `PAYPAL_WEBHOOK_ID` que va al cajón `accounts`. Los eventos son los que
 * `Accounts.webhook` entiende: la suscripción (alta, cancelación, impago, suspensión,
 * reactivación, vencimiento) y cada cobro.
 *
 *   PAYPAL_CLIENT_ID=… PAYPAL_SECRET=… [PAYPAL_LIVE=1] node scripts/setup-webhook.mjs [url]
 */
import { paypalClient } from '../src/paypal.js'

const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_LIVE } = process.env
const url = process.argv[2] || 'https://accounts.dotrino.com/paypal/webhook'
const paypal = paypalClient({ clientId: PAYPAL_CLIENT_ID, secret: PAYPAL_SECRET, live: PAYPAL_LIVE === '1' })
const EVENTS = [
  'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED', 'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.UPDATED', 'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'
]
const existing = (await paypal.listWebhooks()).find((w) => w.url === url)
const w = existing || await paypal.createWebhook({ url, eventTypes: EVENTS })
console.log(`${paypal.live ? 'live' : 'sandbox'} · webhook ${existing ? 'already there' : 'created'} · ${url}`)
console.log(`PAYPAL_WEBHOOK_ID=${w.id}`)
