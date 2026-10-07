import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAgentPackageWithRuntime } from '../src/index.mjs'
const bin = fileURLToPath(new URL('./fake-gemini.mjs', import.meta.url))
const profile = { id: 'test', provider: 'google', model: 'test-model', protocol: 'google-generative-ai', apiKeyEnv: 'PROFILE_KEY', baseUrl: 'http://127.0.0.1:9999' }
async function setup(t, config = {}, runtime = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'talent-gemini-test-'))
  const opts = { workspace: dir, stateDir: resolve(dir, 'state'), env: { PROFILE_KEY: 'test-secret-value', GEMINI_API_KEY: 'ambient-wrong', TEST_CAPTURE: resolve(dir, 'capture.json') }, config }
  const implementation = { command: process.execPath, bin, spawnProcess: spawn, ...runtime }
  const agent = await createAgentPackageWithRuntime(opts, implementation)
  t.after(async () => { await agent.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { agent, dir, opts, implementation }
}
const task = (input = 'hello', extra = {}) => ({ taskId: 't', input, sessionId: 's', model: profile, ...extra })
const collect = async iterable => { const events = []; for await (const e of iterable) events.push(e); return events }

test('routes external profile, projects tools/text and persists model-scoped upstream session', async t => {
  const { agent, dir, opts, implementation } = await setup(t)
  const events = await collect(agent.executeTask(task()))
  assert.equal(events.at(-1).type, 'assistant-complete')
  assert.equal(events.find(e => e.type === 'tool-result').name, 'read_file')
  const capture = JSON.parse(await readFile(resolve(dir, 'capture.json'), 'utf8'))
  assert.equal(capture.key, 'test-secret-value')
  assert.equal(capture.baseUrl, profile.baseUrl)
  assert(capture.args.includes(profile.model)); assert.equal(capture.settings.advanced.ignoreLocalEnv, true)
  assert.equal(capture.settings.security.auth.enforcedType, 'gemini-api-key')
  const saved = await readFile(resolve(dir, 'state', 'sessions.json'), 'utf8')
  assert(!saved.includes('test-secret-value'))
  await agent.dispose()
  const resumed = await createAgentPackageWithRuntime(opts, implementation)
  try {
    await collect(resumed.executeTask(task('follow', { taskId: 'next' })))
    assert(JSON.parse(await readFile(resolve(dir, 'capture.json'), 'utf8')).args.includes('--resume'))
    await collect(resumed.executeTask(task('fresh', { taskId: 'different', model: { ...profile, model: 'another-model' } })))
    assert(!JSON.parse(await readFile(resolve(dir, 'capture.json'), 'utf8')).args.includes('--resume'))
  } finally { await resumed.dispose() }
})
test('rejects missing model, incompatible protocol, endpoint credentials and legacy route config', async t => {
  const { agent, opts, implementation } = await setup(t)
  assert.throws(() => agent.executeTask(task('hi', { model: undefined })), /profile/)
  assert.throws(() => agent.executeTask(task('hi', { model: { ...profile, protocol: 'openai-responses' } })), /protocol/)
  assert.throws(() => agent.executeTask(task('hi', { model: { ...profile, baseUrl: 'https://user:pass@host' } })), /baseUrl/)
  await assert.rejects(createAgentPackageWithRuntime({ ...opts, config: { model: 'hardcoded' } }, implementation), /profile/)
})
test('malformed and failed upstream output never completes; credentials are redacted', async t => {
  const { agent } = await setup(t)
  for (const input of ['bad', 'error']) {
    const events = await collect(agent.executeTask(task(input)))
    assert(events.some(e => e.type === 'error'))
    assert(!events.some(e => e.type === 'assistant-complete'))
    assert(!JSON.stringify(events).includes('test-secret-value'))
  }
})
test('pre-abort, scoped cancellation, iterator return and disposal stop actual subprocess', async t => {
  const { agent } = await setup(t)
  const controller = new AbortController(); controller.abort()
  assert.deepEqual(await collect(agent.executeTask(task(), { signal: controller.signal })), [{ type: 'cancelled' }])
  const iterable = agent.executeTask(task('stall'))
  assert.throws(() => agent.executeTask(task()), /active/)
  const iterator = iterable[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'session')
  await agent.cancelTask('wrong')
  await agent.cancelTask('t')
  assert.equal((await iterator.next()).value.type, 'cancelled')
  assert((await iterator.next()).done)
  const next = agent.executeTask(task('stall'))[Symbol.asyncIterator]()
  await next.next(); await next.return()
  assert.equal((await collect(agent.executeTask(task()))).at(-1).type, 'assistant-complete')
  await agent.dispose()
  assert.throws(() => agent.executeTask(task()), /disposed/)
})
test('cancellation during asynchronous startup prevents spawning', async t => {
  let release, spawned = 0
  const barrier = new Promise(r => { release = r })
  const { agent } = await setup(t, {}, { beforeSpawn: () => barrier, spawnProcess(...args) { spawned++; return spawn(...args) } })
  const events = collect(agent.executeTask(task()))
  await new Promise(r => setTimeout(r, 20))
  const cancel = agent.cancelTask('t'); release(); await cancel
  assert.deepEqual(await events, [{ type: 'cancelled' }]); assert.equal(spawned, 0)
})
