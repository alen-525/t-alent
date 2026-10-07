import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost, loadPackage, readPackageManifest } from './host.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ids = ['pi', 'opencode', 'gemini', 'goose', 'cline']
const packageDirs = ids.map(id => path.join(repo, 'packs', id))

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talent-new-packs-host-'))
  const workspace = path.join(root, 'workspace')
  await import('node:fs/promises').then(fs => fs.mkdir(workspace))
  const modelsPath = path.join(root, 'models.json')
  const gooseProgram = path.join(root, 'goose-runtime-probe.mjs')
  const gooseMarker = path.join(root, 'goose-task-spawned')
  await writeFile(gooseProgram, `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('goose v1.48.0'); else await import('node:fs/promises').then(fs => fs.writeFile(process.env.GOOSE_MODEL_SPAWN_MARKER, 'called'))\n`)
  await chmod(gooseProgram, 0o755)
  const configPath = path.join(root, 'packages.json')
  await writeFile(configPath, JSON.stringify({ goose: { program: gooseProgram } }))
  await writeFile(modelsPath, JSON.stringify({ models: [{ id: 'mismatch-profile', name: 'No supported protocol', provider: 'integration-fixture', model: 'unused', protocol: 'integration-never-supported', apiKeyEnv: 'NO_REAL_CREDENTIAL' }] }))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, workspace, modelsPath, configPath, gooseProgram, gooseMarker, stateDir: path.join(root, 'state') }
}

async function startOrSkip(t, options) {
  try { return await createHost(options) } catch (error) {
    if (error?.code === 'EPERM') { t.skip('Sandbox disallows loopback listening; rerun in the authorized host integration environment.'); return undefined }
    throw error
  }
}

test('the five new manifests are unique and each explicitly loaded runtime rejects a missing model profile before execution', async t => {
  const { workspace, stateDir, gooseProgram, gooseMarker } = await fixture(t)
  const manifests = await Promise.all(packageDirs.map(dir => readPackageManifest(dir)))
  assert.deepEqual(manifests.map(manifest => manifest.id).sort(), [...ids].sort())
  assert.equal(new Set(manifests.map(manifest => manifest.id)).size, ids.length)

  for (let i = 0; i < packageDirs.length; i++) {
    const loaded = await loadPackage(packageDirs[i], { workspace, stateRoot: stateDir, env: { GOOSE_MODEL_SPAWN_MARKER: gooseMarker }, config: { goose: { program: gooseProgram } } })
    try {
      assert.equal(loaded.manifest.id, ids[i])
      assert.equal(typeof loaded.runtime.executeTask, 'function')
      assert.equal(typeof loaded.runtime.cancelTask, 'function')
      assert.equal(typeof loaded.runtime.dispose, 'function')
      assert.throws(() => loaded.runtime.executeTask({ taskId: `missing-${ids[i]}`, input: 'must not call a model', sessionId: 'fixture-session' }), /model profile is required|model profile|Missing model/i)
    } finally { await loaded.runtime.dispose() }
  }
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(gooseMarker)), { code: 'ENOENT' })
})

test('host explicitly loads all five real packages, rejects missing/incompatible profiles before execution, and isolates unloads', async t => {
  const { workspace, stateDir, modelsPath, configPath, gooseProgram, gooseMarker } = await fixture(t)
  const host = await startOrSkip(t, { packagePaths: packageDirs, workspace, stateDir, modelsPath, configPath, env: { GOOSE_MODEL_SPAWN_MARKER: gooseMarker }, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const auth = { origin: base, 'content-type': 'application/json' }
  const packages = await fetch(`${base}/api/packages`).then(response => response.json())
  assert.deepEqual(packages.packages.map(row => row.manifest.id).sort(), [...ids].sort())
  assert.ok(packages.packages.every(row => row.runtimeReady))
  const catalog = await fetch(`${base}/api/models`).then(response => response.json())
  assert.deepEqual(catalog.models.map(({ id, provider, model, protocol }) => ({ id, provider, model, protocol })), [{ id: 'mismatch-profile', provider: 'integration-fixture', model: 'unused', protocol: 'integration-never-supported' }])
  assert.doesNotMatch(JSON.stringify(catalog), /apiKey|NO_REAL_CREDENTIAL/)

  for (const packageId of ids) {
    const missing = await fetch(`${base}/api/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ packageId, taskId: `missing-${packageId}`, sessionId: 'fixture-session', input: 'no profile' }) })
    assert.equal(missing.status, 400, `${packageId} must reject a missing external profile before calling its runtime`)
    const incompatible = await fetch(`${base}/api/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ packageId, modelId: 'mismatch-profile', taskId: `protocol-${packageId}`, sessionId: 'fixture-session', input: 'wrong protocol' }) })
    assert.equal(incompatible.status, 409, `${packageId} must reject an unsupported protocol before execution`)
  }
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(gooseMarker)), { code: 'ENOENT' })

  const unload = await fetch(`${base}/api/packages/opencode/unload`, { method: 'POST', headers: auth, body: '{}' })
  assert.equal(unload.status, 200)
  const after = await fetch(`${base}/api/packages`).then(response => response.json())
  assert.deepEqual(after.packages.map(row => row.manifest.id).sort(), ids.filter(id => id !== 'opencode').sort())
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ packageId: 'opencode', modelId: 'mismatch-profile', taskId: 'after-unload', sessionId: 'another', input: 'must not run' }) })).status, 409)
})
