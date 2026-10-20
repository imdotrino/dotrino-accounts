/**
 * La administración del servicio (`docs/DISENO.md` §10), por la sesión cifrada de
 * `@dotrino/remote-agent`. La pide la página `vault.dotrino.com/admin` desde un aparato de la
 * cuenta de Dotrino.
 *
 *   → { type: 'admin', rid, op, args }
 *   ← { type: 'admin.result', rid, ok: true, result }
 *   ← { type: 'admin.result', rid, ok: false, code, error }
 *
 * QUIÉN PUEDE: solo un aparato con `admin` en el acta de Dotrino. Abrir sesión ya exige ser
 * del acta y poder firmar; esto exige además `admin`, y se pregunta en CADA petición al acta
 * de confianza del agente (`checkCap`), nunca a lo que diga la página. Sin acta no se decide:
 * se contesta `no-record`.
 */
import { keyLabel } from '@dotrino/identity/capabilities'

export const ADMIN_CAP = 'admin'

/** Lo que se puede pedir, y qué método de `Accounts` lo hace. */
const OPS = {
  list: (a, args, by) => a.adminList({ by }),
  setOn: (a, args, by) => a.adminSetOn({ id: args.id, on: args.on, by }),
  refund: (a, args, by) => a.adminRefund({ id: args.id, by }),
  addReplica: (a, args, by) => a.adminAddReplica({ account: args.account, product: args.product, by }),
  remove: (a, args, by) => a.adminRemove({ id: args.id, by })
}
export const ADMIN_OPS = Object.freeze(Object.keys(OPS))

/**
 * @param {{ accounts: import('./accounts.js').Accounts, checkCap: (pub:string, cap:string) => Promise<{ok:boolean, code?:string}>, log?: Function }} o
 * @returns {(device: string, msg: any) => Promise<object|null>} la respuesta, o null si el mensaje no es de administración.
 */
export function makeAdmin ({ accounts, checkCap, log = () => {} }) {
  if (typeof checkCap !== 'function') throw Object.assign(new Error('admin: checkCap is required (@dotrino/remote-agent >= 0.23.0)'), { code: 'remote-agent-too-old' })
  return async function handle (device, msg) {
    if (msg?.type !== 'admin') return null
    const rid = msg.rid
    const reply = (r) => ({ type: 'admin.result', rid, ...r })
    const by = await keyLabel(device)
    const gate = await checkCap(device, ADMIN_CAP)
    if (!gate.ok) {
      const code = gate.code === 'no-record' ? 'no-record' : 'forbidden'
      log(`[accounts] admin ${by}: ${msg.op} refused (${gate.code})`)
      return reply({ ok: false, code, reason: gate.code, error: code === 'no-record' ? 'the service has no trusted record to check permissions' : 'this device does not have the admin permission' })
    }
    const fn = Object.hasOwn(OPS, msg.op) ? OPS[msg.op] : null
    if (!fn) return reply({ ok: false, code: 'unknown-op', error: `unknown admin op ${msg.op}` })
    if (msg.args !== undefined && (typeof msg.args !== 'object' || msg.args === null)) return reply({ ok: false, code: 'bad-request', error: 'args must be an object' })
    try {
      return reply({ ok: true, result: await fn(accounts, msg.args || {}, by) })
    } catch (e) {
      log(`[accounts] admin ${by}: ${msg.op} failed: ${e.code || 'internal'} ${e.message}`)
      return reply({ ok: false, code: e.code || 'internal', error: e.message })
    }
  }
}
