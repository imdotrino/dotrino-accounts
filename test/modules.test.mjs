// Que cada módulo cargue: accounts.test.mjs usa dobles de vaults/http, y un error de sintaxis
// en ellos salió a producción (0.3.0) sin que ninguna prueba los importara.
import { test } from 'node:test'
import fs from 'node:fs'

for (const f of fs.readdirSync(new URL('../src/', import.meta.url))) {
  test(`src/${f} loads`, async () => { await import(`../src/${f}`) })
}
