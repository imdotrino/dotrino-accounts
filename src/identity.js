/**
 * La identidad del servicio: un aparato del acta de Dotrino, enrolado por el camino estándar
 * de los agentes headless (`@dotrino/remote-agent/link`), como names. Lee SOLO su cajón de
 * secretos (`vault:secrets:accounts`: PayPal y la llave de AWS acotada). Se empareja con
 * `dotrino-vault pair --service accounts`.
 */
import { loadLink, clientLink, dataDir, renewLink, enroll } from '@dotrino/remote-agent/link'
import { waitForSecrets } from '@dotrino/vault/service'
import { formatDeviceInfo, deviceInfo } from '@dotrino/vault/device-info'

export const NS = 'accounts'
export const LABEL = 'accounts'

export function identityDir () { return process.env.ACCOUNTS_DIR || dataDir('dotrino-accounts') }

export async function enrollService (invite, { dir = identityDir() } = {}) {
  return enroll({ qr: invite, dir, label: LABEL, ns: NS })
}

/** Qué aparato es (CONVENCIONES §15.1): el ID primero. Sin red, del enlace del disco. */
export async function info ({ dir = identityDir(), json = false } = {}) {
  const link = loadLink(dir)
  if (!link?.device?.publickey) throw Object.assign(new Error(`not enrolled (dir ${dir})`), { code: 'not-enrolled' })
  const i = await deviceInfo(link, { kind: 'accounts', name: LABEL, ns: NS, dir })
  return json ? JSON.stringify(i, null, 2) : formatDeviceInfo(i)
}

export async function loadServiceIdentity ({ dir = identityDir(), log = console.log } = {}) {
  const raw = loadLink(dir)
  if (!raw?.device?.privateJwk) throw Object.assign(new Error(`not enrolled: run \`dotrino-accounts enroll <invite>\` (dir ${dir})`), { code: 'not-enrolled' })
  if (!raw.enc?.privateJwk) throw Object.assign(new Error('this link has no encryption key: enroll again'), { code: 'no-enc' })
  const r = await renewLink(raw, { dir })
  if (r.renewed) log(`[identity] cert renewed · acta #${r.seq}`)
  else if (r.reason && r.reason !== 'not due') log(`[identity] cert not renewed: ${r.reason}`)
  const link = clientLink(raw, { dir })
  return { device: raw.device.publickey, secretsArgs: { ns: NS, proxyUrl: link.proxy, masterPubkey: raw.iss, device: raw.device, cert: raw.cert, enc: raw.enc } }
}

/** Los secretos del cajón `accounts`. Espera a la bóveda: sin ella no se cobra ni se crean bóvedas. */
export async function loadSecrets (identity, { log = console.log, product, version } = {}) {
  return waitForSecrets({ ...identity.secretsArgs, product, version, onRetry: (e, ms) => log(`[vault] ${e.message}; retry in ${Math.round(ms / 1000)}s`) })
}
