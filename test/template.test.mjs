/**
 * LA PLANTILLA ES LA DE LA ÚLTIMA RELEASE, VERIFICADA (`src/vaults.js`, `latestTemplate`).
 *
 * Iba fijada a mano en el cajón y se quedó en la 0.167: una bóveda nueva nacía con el código de
 * entonces. Sin poder mirar la release o sin poder verificarla, no se crea nada.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { latestTemplate } from '../src/vaults.js'

const release = (version, names) => async () => ({ ok: true, version, assets: names.map((name) => ({ name, url: `https://example.test/${name}` })) })
const verifiedAs = (ok, body = 'AWSTemplateFormatVersion: x') => async (asset) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'))
  const file = path.join(dir, asset.name)
  fs.writeFileSync(file, body)
  return ok ? { ok: true, file } : { ok: false, code: 'BAD_SIGNATURE', reason: 'the signature does not check out', file }
}

test('usa la plantilla de la última release, ya verificada', async () => {
  let pedida = null
  const t = await latestTemplate({
    latest: release('0.181.1', ['dotrino-vault-lambda-0.181.1.zip', 'dotrino-vault-lambda-0.181.1.yaml']),
    verified: async (asset, opts) => { pedida = { asset, repo: opts.repo }; return verifiedAs(true, 'plantilla 0.181.1')(asset) }
  })
  assert.equal(t.version, '0.181.1')
  assert.equal(t.body, 'plantilla 0.181.1')
  assert.equal(pedida.asset.name, 'dotrino-vault-lambda-0.181.1.yaml')
  assert.equal(pedida.repo, 'imdotrino/dotrino-vault', 'se verifica contra el repo de la bóveda')
})

test('si no se puede mirar la release, se para', async () => {
  await assert.rejects(latestTemplate({ latest: async () => ({ ok: false, reason: 'GitHub answered 503' }), verified: verifiedAs(true) }),
    (e) => e.code === 'template-unavailable' && /503/.test(e.message))
})

test('una release sin plantilla no crea nada', async () => {
  await assert.rejects(latestTemplate({ latest: release('0.181.1', ['dotrino-vault-lambda-0.181.1.zip']), verified: verifiedAs(true) }),
    (e) => e.code === 'template-unavailable')
})

test('una plantilla que no verifica no se usa, y no queda en el disco', async () => {
  let file = null
  await assert.rejects(latestTemplate({
    latest: release('0.181.1', ['dotrino-vault-lambda-0.181.1.yaml']),
    verified: async (a) => { const r = await verifiedAs(false)(a); file = r.file; return r }
  }), (e) => e.code === 'template-unverified')
  assert.equal(fs.existsSync(file), false)
})
