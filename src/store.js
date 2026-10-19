/**
 * Dónde guarda el servicio lo suyo: un archivo SQLite (`node:sqlite`, sin dependencias).
 *
 *   subs    una fila por suscripción. `id` es el número interno (el `custom_id` de PayPal);
 *           `account` es la cuenta del cliente (64 hex), que firma todo lo que se pide sobre
 *           ella desde la compra. `vault` es el nombre de la pila; `device`, el ID del aparato
 *           que la réplica es en su acta, y `enrolled`, si el dueño ya aprobó su código.
 *           `refund` es la devolución cuando la réplica no llegó a servir: 'pending' mientras
 *           PayPal no haya apuntado el cobro, 'done' devuelto, 'none' no se llegó a cobrar.
 *   events  cada webhook de PayPal tal cual, para poder auditar qué pasó y cuándo
 *   nonces  las peticiones firmadas ya usadas (anti-repetición), hasta que caducan
 */
import { DatabaseSync } from 'node:sqlite'

const COLS = ['id', 'account', 'product', 'paypal_id', 'status', 'paid_through', 'vault', 'stack', 'device', 'enrolled', 'vault_on', 'refund', 'note', 'created', 'updated']

export class Store {
  constructor (file = ':memory:') {
    this.db = new DatabaseSync(file)
    // Una base de antes de la réplica (con `claim` y el código de activación) no se migra: en
    // fase de desarrollo solo tenía compras de prueba. Se dice y se para.
    if (this.db.prepare('PRAGMA table_info(subs)').all().some((c) => c.name === 'claim')) {
      throw Object.assign(new Error(`store: ${file} is from before the hosted replica (it has a claim column): move it aside`), { code: 'old-store' })
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS subs (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, product TEXT NOT NULL, paypal_id TEXT UNIQUE,
        status TEXT NOT NULL, paid_through INTEGER, vault TEXT UNIQUE, stack TEXT NOT NULL DEFAULT 'none',
        device TEXT, enrolled INTEGER NOT NULL DEFAULT 0, vault_on INTEGER NOT NULL DEFAULT 0,
        refund TEXT, note TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS subs_account ON subs (account);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, sub TEXT, kind TEXT NOT NULL, json TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    `)
  }

  insert (row) {
    const cols = COLS.filter((c) => row[c] !== undefined)
    this.db.prepare(`INSERT INTO subs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]))
  }

  update (id, fields) {
    const cols = Object.keys(fields)
    for (const c of cols) if (!COLS.includes(c)) throw new Error(`store: unknown column ${c}`)
    this.db.prepare(`UPDATE subs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), id)
  }

  get (id) { return this.db.prepare('SELECT * FROM subs WHERE id = ?').get(id) || null }
  byPaypal (paypalId) { return this.db.prepare('SELECT * FROM subs WHERE paypal_id = ?').get(paypalId) || null }
  ofAccount (account) { return this.db.prepare('SELECT * FROM subs WHERE account = ? ORDER BY created').all(account) }
  /** Las que tienen algo que vigilar: una suscripción en PayPal o una pila que no se borró. */
  live () { return this.db.prepare("SELECT * FROM subs WHERE stack != 'deleted' AND (paypal_id IS NOT NULL OR stack != 'none')").all() }

  /** @returns {boolean} false si el evento ya se había visto (PayPal reintenta). */
  addEvent ({ id, sub, kind, json, ts }) {
    const r = this.db.prepare('INSERT OR IGNORE INTO events (id, sub, kind, json, ts) VALUES (?, ?, ?, ?, ?)').run(id, sub, kind, json, ts)
    return r.changes === 1
  }

  /** @returns {boolean} false si el nonce ya se usó. */
  useNonce (nonce, exp, now) {
    this.db.prepare('DELETE FROM nonces WHERE exp < ?').run(now)
    return this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, exp) VALUES (?, ?)').run(nonce, exp).changes === 1
  }
}
