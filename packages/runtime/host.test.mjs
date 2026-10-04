import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHost, loadPackage, parseHostArgs, readPackageManifest } from './host.mjs'

async function fixture(t, runtimeSource) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talent-host-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pack = path.join(root, 'explicit-pack')
  await mkdir(pack)
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify({ id: 'test.fake', name: 'Test Fake', version: '1.0.0', entry: 'index.mjs' }))
  await writeFile(path.join(pack, 'index.mjs'), runtimeSource)
  return { root, pack, workspace: root }
}

const fakeRuntime = `export function createAgentPackage() {
  let release
  let cancelled = false
  return {
    executeTask({ input, sessionId }) { return (async function* () { const gate = new Promise(resolve => { release = resolve }); yield { type: 'assistant-delta', text: input + ':' + sessionId }; await gate; await new Promise(resolve => setTimeout(resolve, 45)); yield { type: 'assistant-complete' } })() },
    async cancelTask() { cancelled = true; release?.() },
    async dispose() { release?.() },
  }
}`

test('host CLI accepts a package only from an explicit local path', () => {
  assert.deepEqual(parseHostArgs(['--package', './packs/x', '--workspace', '/tmp/work', '--port', '8787', '--state-dir', '.talent', '--config', 'settings.json', '--models', 'models.json']), {
    package: ['./packs/x'], workspace: '/tmp/work', port: 8787, statedir: '.talent', config: 'settings.json', models: 'models.json',
  })
  assert.deepEqual(parseHostArgs(['--package', './packs/a', '--package', './packs/b', '--workspace', '/tmp/work']).package, ['./packs/a', './packs/b'])
  assert.throws(() => parseHostArgs(['--workspace', '/tmp/work', 'deepseek']), /Unknown host option/)
  assert.equal(parseHostArgs(['--workspace', '/tmp/work']).package, undefined)
})

test('inspecting metadata never imports package code, while explicitly loading its directory does', async t => {
  const { pack, workspace } = await fixture(t, `globalThis.fakePackImported = true; ${fakeRuntime}`)
  const manifest = await readPackageManifest(pack)
  assert.equal(manifest.id, 'test.fake')
  assert.equal(globalThis.fakePackImported, undefined)
  const loaded = await loadPackage(pack, { workspace, stateRoot: path.join(workspace, '.state') })
  t.after(() => loaded.runtime.dispose())
  assert.equal(globalThis.fakePackImported, true)
  assert.deepEqual(loaded.manifest, manifest)
})

test('an entry that resolves outside the explicit pack is rejected before import', async t => {
  const { root, pack, workspace } = await fixture(t, 'throw new Error("entry should not execute")')
  await writeFile(path.join(root, 'outside.mjs'), 'throw new Error("outside entry executed")')
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify({ id: 'test.fake', name: 'Test Fake', version: '1.0.0', entry: '../outside.mjs' }))
  await assert.rejects(createHost({ packagePath: pack, workspace, port: 0 }), /inside its package directory/)
})

test('task events are streamed and cancellation waits for the package task to finish', async t => {
  const { pack, workspace } = await fixture(t, fakeRuntime)
  const host = await startHostOrSkip(t, { packagePath: pack, workspace, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const port = host.address.port
  const base = `http://127.0.0.1:${port}`
  const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'task-one', sessionId: 'conversation-one', input: 'hello' }) })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const event = await reader.read()
  assert.match(new TextDecoder().decode(event.value), /hello:conversation-one/)
  const overlap = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'task-two', sessionId: 'conversation-one', input: 'overlap' }) })
  assert.equal(overlap.status, 409, 'one package cannot execute overlapping tasks')
  let settled = false
  const cancel = fetch(`${base}/api/cancel`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-one' }) }).then(value => { settled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(settled, false, 'cancel waits until the active iterable has ended')
  const result = await cancel
  assert.equal(result.status, 200)
  await reader.cancel()
  const reusedId = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'task-one', sessionId: 'conversation-one', input: 'reuse' }) })
  assert.equal(reusedId.status, 409, 'task ids are unique for the lifetime of the host')
})

test('external model registry is global, secrets stay private, and task receives the complete profile', async t => {
  const runtime = `export function createAgentPackage() { return {
    async *executeTask(args) { yield { type: 'assistant-delta', text: JSON.stringify(args) } },
    async cancelTask() {}, async dispose() {},
  } }`
  const { pack, workspace } = await fixture(t, runtime)
  const host = await startHostOrSkip(t, { packagePath: pack, workspace, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const catalog = await fetch(`${base}/api/models`).then(response => response.json())
  assert.deepEqual(catalog, { models: [{ id: 'test-profile', name: 'Test Profile', provider: 'test-vendor', model: 'upstream-1', protocol: 'fake-protocol', baseUrl: 'https://api.example.test', }], defaultModelId: 'test-profile' })
  assert.doesNotMatch(JSON.stringify(catalog), /apiKey|SECRET|DEMO_KEY/)
  assert.equal((await fetch(`${base}/api/packages/test.fake/models`)).status, 404)
  const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'with-profile', sessionId: 'session-one', input: 'hello', provider: 'attacker', apiKey: 'SECRET' }) })
  assert.equal(response.status, 400)
  const accepted = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'with-profile-ok', sessionId: 'session-one', input: 'hello' }) })
  const args = JSON.parse(JSON.parse((await accepted.text()).trim().split('\n')[0]).text)
  assert.deepEqual(args, { taskId: 'with-profile-ok', input: 'hello', sessionId: 'session-one', model: { id: 'test-profile', name: 'Test Profile', provider: 'test-vendor', model: 'upstream-1', protocol: 'fake-protocol', apiKeyEnv: 'DEMO_KEY', baseUrl: 'https://api.example.test' } })
})

test('model registry and protocol selection are validated before package execution', async t => {
  const { root, pack, workspace } = await fixture(t, `globalThis.modelExecutions = 0; export function createAgentPackage() { return {
    async *executeTask() { globalThis.modelExecutions++; yield { type: 'assistant-complete' } },
    async cancelTask() {}, async dispose() {},
  } }`)
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify({ id: 'test.fake', name: 'Test Fake', version: '1.0.0', entry: 'index.mjs', modelProtocols: ['other-protocol'] }))
  const host = await startHostOrSkip(t, { packagePath: pack, workspace, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const request = async (taskId, extras = {}) => fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId, sessionId: 'session', input: 'hello', ...extras }) })
  assert.equal((await request('protocol-mismatch')).status, 409)
  assert.equal((await request('missing-profile', { modelId: undefined })).status, 400)
  assert.equal(globalThis.modelExecutions, 0)
  for (const invalid of [
    { models: [{ id: 'x', provider: 'p', model: 'm', protocol: 'p', apiKeyEnv: 'KEY', token: 'secret' }] },
    { models: [{ id: 'x', provider: 'p', model: 'm', protocol: 'p', apiKeyEnv: 'KEY' }, { id: 'x', provider: 'p', model: 'm', protocol: 'p', apiKeyEnv: 'KEY' }] },
    { models: [{ id: 'x', provider: 'p', model: 'm', protocol: 'p', apiKeyEnv: 'KEY', baseUrl: 'https://user:pass@example.test' }] },
  ]) {
    const modelsPath = path.join(root, `invalid-${Math.random()}.json`)
    await writeFile(modelsPath, JSON.stringify(invalid))
    await assert.rejects(createHost({ workspace, modelsPath, port: 0 }), /Invalid model registry/)
  }
})

test('a session cannot switch model profiles', async t => {
  const { root, pack, workspace } = await fixture(t, fakeRuntime)
  const modelsPath = path.join(root, 'registry.json')
  await writeFile(modelsPath, JSON.stringify({ models: [
    { id: 'profile-a', provider: 'vendor', model: 'upstream-a', protocol: 'fake-protocol', apiKeyEnv: 'KEY_A' },
    { id: 'profile-b', provider: 'vendor', model: 'upstream-b', protocol: 'fake-protocol', apiKeyEnv: 'KEY_B' },
  ] }))
  const host = await startHostOrSkip(t, { packagePath: pack, workspace, modelsPath, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const post = (taskId, modelId) => fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId, taskId, sessionId: 'shared-session', input: 'run' }) })
  assert.equal((await post('profile-a-first', 'profile-a')).status, 200)
  assert.equal((await post('profile-b-second', 'profile-b')).status, 409)
})

test('unloading a package cancels its live task and disposes only that package', async t => {
  const { pack, workspace } = await fixture(t, `globalThis.unloadLifecycle = { cancel: 0, dispose: 0 }; let release; export function createAgentPackage() { return {
    executeTask() { return (async function* () { yield { type: 'assistant-delta', text: 'started' }; await new Promise(resolve => { release = resolve }) })() },
    async cancelTask() { globalThis.unloadLifecycle.cancel++; release?.() },
    async dispose() { globalThis.unloadLifecycle.dispose++ },
  } }`)
  const host = await startHostOrSkip(t, { packagePaths: [pack], workspace, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'test.fake', modelId: 'test-profile', taskId: 'unload-task', sessionId: 'conversation', input: 'run' }) })
  const reader = response.body.getReader()
  await reader.read()
  const unloaded = await fetch(`${base}/api/packages/test.fake/unload`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unloaded.status, 200)
  assert.deepEqual(globalThis.unloadLifecycle, { cancel: 1, dispose: 1 })
  assert.deepEqual((await fetch(`${base}/api/packages`).then(result => result.json())).packages, [])
  await reader.cancel()
})

test('empty host has no executable package and same-origin JSON is required for mutation', async t => {
  const { workspace } = await fixture(t, fakeRuntime)
  const host = await startHostOrSkip(t, { workspace, port: 0, noModels: true })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  const packages = await fetch(`${base}/api/packages`).then(response => response.json())
  assert.deepEqual(packages.packages, [])
  assert.deepEqual(await fetch(`${base}/api/models`).then(response => response.json()), { models: [] }, 'there is no package-provided or built-in model fallback')
  const noOrigin = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noOrigin.status, 403)
  const crossSite = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(crossSite.status, 403)
  const wrongContent = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(wrongContent.status, 415)
  const nullBody = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: 'null' })
  assert.equal(nullBody.status, 400)
  const wrongPort = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: 'http://127.0.0.1:8999', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(wrongPort.status, 403)
  const vitePort = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(vitePort.status, 409, 'Vite origin is allowed, then package selection validation runs')
})

test('two packages keep config and state isolated, route by id, and survive the other package unloading', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talent-host-pair-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = []
  for (const id of ['fixture.alpha', 'fixture.beta']) {
    const pack = path.join(root, id)
    await mkdir(pack)
    await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.mjs' }))
    await writeFile(path.join(pack, 'index.mjs'), `export function createAgentPackage({ stateDir, config }) { return {
      listModels() { return { models: [{ id: ${JSON.stringify(`${id}-model`)} }], defaultModel: ${JSON.stringify(`${id}-model`)} } },
      async *executeTask({ input }) { yield { type: 'assistant-delta', text: JSON.stringify({ id: ${JSON.stringify(id)}, input, model: config.model, stateDir }) } },
      async cancelTask() {}, async dispose() {},
    } }`)
    packages.push(pack)
  }
  const stateDir = path.join(root, 'state')
  const configPath = path.join(root, 'packages.json')
  await writeFile(configPath, JSON.stringify({ 'fixture.alpha': { model: 'alpha-config' }, 'fixture.beta': { model: 'beta-config' } }))
  const host = await startHostOrSkip(t, { packagePaths: packages, workspace: root, stateDir, configPath, port: 0 })
  if (!host) return
  t.after(() => host.close())
  const base = `http://127.0.0.1:${host.address.port}`
  assert.deepEqual(await fetch(`${base}/api/models`).then(response => response.json()), { models: [{ id: 'test-profile', name: 'Test Profile', provider: 'test-vendor', model: 'upstream-1', protocol: 'fake-protocol', baseUrl: 'https://api.example.test' }], defaultModelId: 'test-profile' })
  assert.equal((await fetch(`${base}/api/packages/fixture.alpha/models`)).status, 404)
  const run = async (packageId, taskId, input) => {
    const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId, modelId: 'test-profile', taskId, sessionId: 'shared-session', input }) })
    assert.equal(response.status, 200)
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    return JSON.parse(events[0].text)
  }

  assert.deepEqual(await run('fixture.alpha', 'alpha-task', 'alpha input'), { id: 'fixture.alpha', input: 'alpha input', model: 'alpha-config', stateDir: path.join(stateDir, 'fixture.alpha') })
  assert.deepEqual(await run('fixture.beta', 'beta-task', 'beta input'), { id: 'fixture.beta', input: 'beta input', model: 'beta-config', stateDir: path.join(stateDir, 'fixture.beta') })

  const unloaded = await fetch(`${base}/api/packages/fixture.alpha/unload`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unloaded.status, 200)
  assert.deepEqual(await run('fixture.beta', 'beta-after-unload', 'still available'), { id: 'fixture.beta', input: 'still available', model: 'beta-config', stateDir: path.join(stateDir, 'fixture.beta') })
  assert.deepEqual(await fetch(`${base}/api/models`).then(response => response.json()), { models: [{ id: 'test-profile', name: 'Test Profile', provider: 'test-vendor', model: 'upstream-1', protocol: 'fake-protocol', baseUrl: 'https://api.example.test' }], defaultModelId: 'test-profile' })
  const unavailable = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'fixture.alpha', modelId: 'test-profile', taskId: 'alpha-after-unload', sessionId: 'session', input: 'should not run' }) })
  assert.equal(unavailable.status, 409)
})

async function startHostOrSkip(t, options) {
  const { noModels, ...hostOptions } = options
  const modelsPath = hostOptions.modelsPath ?? path.join(hostOptions.workspace, 'models.json')
  if (!hostOptions.modelsPath && !noModels) await writeFile(modelsPath, JSON.stringify({ models: [{ id: 'test-profile', name: 'Test Profile', provider: 'test-vendor', model: 'upstream-1', protocol: 'fake-protocol', apiKeyEnv: 'DEMO_KEY', baseUrl: 'https://api.example.test' }], defaultModelId: 'test-profile' }))
  try { return await createHost({ ...hostOptions, ...(noModels ? {} : { modelsPath }) }) } catch (error) {
    if (error?.code === 'EPERM') { t.skip('Sandbox disallows loopback listening; rerun in the authorized host integration environment.'); return undefined }
    throw error
  }
}
