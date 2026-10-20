#!/usr/bin/env node
/**
 * dotrino-accounts — el servicio de cuentas (`accounts.dotrino.com`): vende, activa, renueva y
 * apaga las bóvedas alojadas (`docs/DISENO.md`).
 *
 *   dotrino-accounts serve              arranca (PORT, ACCOUNTS_DB, ACCOUNTS_DIR, ACCOUNTS_SHOP_URL)
 *                                       y atiende la administración por `@dotrino/remote-agent` (§10)
 *   dotrino-accounts enroll <invite>    se empareja con la bóveda de Dotrino
 *   dotrino-accounts info [--json]      qué aparato es (CONVENCIONES §15.1)
 *
 * Todo lo de configurar sale del cajón `accounts`: PayPal (PAYPAL_CLIENT_ID, PAYPAL_SECRET,
 * PAYPAL_LIVE, PAYPAL_REPLICA_PLAN_ID, PAYPAL_WEBHOOK_ID) y AWS (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_REGION, VAULT_TEMPLATE_URL, VAULT_TEMPLATE_SHA256,
 * VAULT_SHARED_KEY_ARN, VAULT_CFN_ROLE_ARN, VAULT_ROLE_BOUNDARY_ARN). Sin la bóveda no arranca: no hay con qué cobrar ni dónde crear nada.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { watchForUpdate } from '@dotrino/update'
import { Store } from './src/store.js'
import { Accounts } from './src/accounts.js'
import { paypalClient } from '@dotrino/pay'
import { awsVaults } from './src/vaults.js'
import { makeHandler } from './src/http.js'
import { makeAdmin } from './src/admin.js'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { loadServiceIdentity, loadSecrets, enrollService, info, identityDir, LABEL } from './src/identity.js'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const log = (...a) => console.log(new Date().toISOString(), ...a)
const [cmd = 'serve', arg] = process.argv.slice(2)
const die = (e) => { console.error(`dotrino-accounts: ${e.message}${e.code ? ` (${e.code})` : ''}`); process.exit(1) }

if (cmd === 'info') {
  console.log(await info({ json: process.argv.includes('--json') }).catch(die))
} else if (cmd === 'enroll') {
  if (!arg) { console.error('usage: dotrino-accounts enroll <invite>'); process.exit(2) }
  const link = await enrollService(arg).catch(die)
  console.log(`enrolled as a device of the Dotrino account (${link.iss.slice(0, 16)}…)`)
} else if (cmd === 'serve') {
  const identity = await loadServiceIdentity({ log }).catch(die)
  const s = await loadSecrets(identity, { log }).catch(die)
  const need = ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_REPLICA_PLAN_ID', 'PAYPAL_WEBHOOK_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'VAULT_TEMPLATE_URL', 'VAULT_TEMPLATE_SHA256', 'VAULT_SHARED_KEY_ARN', 'VAULT_CFN_ROLE_ARN', 'VAULT_ROLE_BOUNDARY_ARN']
  const missing = need.filter((k) => !s[k])
  if (missing.length) die(Object.assign(new Error(`drawer "accounts" lacks ${missing.join(', ')}`), { code: 'misconfigured' }))
  const paypal = paypalClient({ clientId: s.PAYPAL_CLIENT_ID, secret: s.PAYPAL_SECRET, live: s.PAYPAL_LIVE === '1' })
  const vaults = awsVaults({
    region: s.AWS_REGION,
    credentials: { accessKeyId: s.AWS_ACCESS_KEY_ID, secretAccessKey: s.AWS_SECRET_ACCESS_KEY },
    templateUrl: s.VAULT_TEMPLATE_URL, templateSha256: s.VAULT_TEMPLATE_SHA256, sharedKeyArn: s.VAULT_SHARED_KEY_ARN, cfnRoleArn: s.VAULT_CFN_ROLE_ARN, roleBoundaryArn: s.VAULT_ROLE_BOUNDARY_ARN
  })
  const accounts = new Accounts({
    store: new Store(process.env.ACCOUNTS_DB || 'accounts.db'), vaults, paypal,
    // La segunda bóveda se vende cuando su plan está en el cajón (`scripts/setup-plan.mjs vault`).
    planIds: { replica: s.PAYPAL_REPLICA_PLAN_ID, ...(s.PAYPAL_VAULT_PLAN_ID ? { vault: s.PAYPAL_VAULT_PLAN_ID } : {}) },
    webhookId: s.PAYPAL_WEBHOOK_ID,
    shopUrl: process.env.ACCOUNTS_SHOP_URL || 'https://vault.dotrino.com/hosted', log
  })
  const port = Number(process.env.PORT || 8095)
  http.createServer(makeHandler({ accounts, version: pkg.version, product: pkg.name, log }))
    .listen(port, '127.0.0.1', () => log(`[accounts] listening on 127.0.0.1:${port} · payments ${paypal.live ? 'live' : 'sandbox'} · on sale: ${Object.keys(accounts.planIds).join(', ')}`))

  // LA ADMINISTRACIÓN (§10): el mismo enlace del servicio atiende sesiones cifradas de los
  // aparatos de la cuenta de Dotrino. El pong dice `kind: 'accounts'`, que es como la página
  // /admin encuentra este servicio; quién puede administrar lo decide el acta en cada petición.
  let ra = null
  const admin = makeAdmin({ accounts, checkCap: (pub, cap) => ra.checkCap(pub, cap), log })
  ra = await startRemoteAgent({
    label: LABEL, dir: identityDir(),
    onSession (session) {
      session.on('message', (msg) => {
        admin(session.device, msg)
          .then((reply) => { if (reply) session.send(reply) })
          .catch((e) => log(`[accounts] admin: ${e.code || ''} ${e.message}`))
      })
    },
    onRevoked () { log('[accounts] this service was revoked from the Dotrino record: exiting'); process.exit(1) }
  }).catch(die)

  // Cada 15 min: pilas a medio crear y el estado de cada suscripción en PayPal.
  const sweep = () => accounts.sweep().catch((e) => log(`[accounts] sweep: ${e.message}`))
  setInterval(sweep, 15 * 60 * 1000).unref()
  sweep()
  watchForUpdate({ name: pkg.name, version: pkg.version, log }).catch?.(() => {})
} else {
  console.error('usage: dotrino-accounts serve | enroll <invite> | info [--json]')
  process.exit(2)
}
