import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'
const key = 'roo-selected-private-key'
const worker = new URL('./fixtures/fake-roo.mjs', import.meta.url).pathname
const model = { id: 'test-profile', provider: 'arbitrary', model: 'org/model:exact', protocol: 'openai-chat-completions', apiKeyEnv: 'CUSTOM' }
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
async function setup(t) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-roo-contract-'))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"text":"provider echo ' + key.slice(0, 10))
    setImmediate(() => res.end(key.slice(10) + '"}'))
  })
  try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) }) }
  catch (error) { await rm(temp, { recursive: true, force: true }); if (error.code === 'EPERM') { t.skip('The contract uses a local credential relay; rerun with localhost access.'); return } throw error }
  const profile = { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
  const record = join(temp, 'record.json')
  let spawnCount = 0, lastOptions
  const runtime = { command: '/fixture/roo', spawnProcess(_command, _args, options) { spawnCount++; lastOptions = options; return spawn(process.execPath, [worker], options) } }
  const options = { workspace: temp, stateDir: join(temp, 'state'), env: { CUSTOM: key, PLAIN_ALIAS: key, AMBIENT_API_KEY: 'ambient-private-key', NODE_OPTIONS: '--trace-warnings', ROO_RECORD_PATH: record }, config: { cancelGraceMs: 60 } }
  const agent = await createAgentPackageWithRuntime(options, runtime)
  t.after(async () => { await agent.dispose(); server.closeAllConnections(); await new Promise(ok => server.close(ok)); await rm(temp, { recursive: true, force: true }) })
  return { agent, options, runtime, profile, requests, record, temp, get spawnCount() { return spawnCount }, get lastOptions() { return lastOptions } }
}
test('authenticates the relay, preserves the model, and hides keys before native persistence', async t => {
  const f = await setup(t); if (!f) return
  const events = await collect(f.agent.executeTask({ taskId: 'relay', input: 'RELAY', model: f.profile }))
  assert.equal(events.at(-1).type, 'assistant-complete')
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].authorization, `Bearer ${key}`)
  assert.equal(f.requests[0].body.model, f.profile.model)
  const result = JSON.parse(events.find(e => e.type === 'tool-result').output)
  assert.equal(result.unauthorized, 401); assert.equal(result.mismatch, 400)
  assert(result.response.includes('[redacted]')); assert(!result.response.includes(key))
  const env = JSON.parse(await readFile(f.record, 'utf8'))
  assert.equal(env.CUSTOM, undefined); assert.equal(env.PLAIN_ALIAS, undefined); assert.equal(env.AMBIENT_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.BROWSER, '/usr/bin/true')
  assert(!String(await readFile(join(env.HOME, 'native-provider-result.txt'))).includes(key))
})
test('bounds UTF-8 lines, stops children ignoring SIGTERM, and rejects incomplete/nonzero turns', async t => {
  const f = await setup(t); if (!f) return
  for (const input of ['MALFORMED', 'OVERSIZED', 'NO_TERMINAL', 'NONZERO']) {
    const events = await collect(f.agent.executeTask({ taskId: input, input, model: f.profile }))
    assert.equal(events.at(-1).type, 'error', input)
    assert(!events.some(event => event.type === 'assistant-complete'))
  }
  assert.equal((await collect(f.agent.executeTask({ taskId: 'recover', input: 'NORMAL', model: f.profile }))).at(-1).type, 'assistant-complete')
})
test('scopes sessions to profile ID and workspace while display names remain cosmetic', async t => {
  const f = await setup(t); if (!f) return
  const run = model => collect(f.agent.executeTask({ taskId: 'task', sessionId: 'same', input: 'NORMAL', model }))
  const first = await run(f.profile), second = await run({ ...f.profile, name: 'new label' }), other = await run({ ...f.profile, id: 'other-profile' })
  assert.equal(first[0].sessionId, second[0].sessionId); assert.notEqual(first[0].sessionId, other[0].sessionId)
  const workspace = join(f.temp, 'other-workspace'); await mkdir(workspace)
  const agent = await createAgentPackageWithRuntime({ ...f.options, workspace }, f.runtime)
  t.after(() => agent.dispose())
  const events = await collect(agent.executeTask({ taskId: 'task', sessionId: 'same', input: 'NORMAL', model: f.profile }))
  assert.notEqual(events[0].sessionId, first[0].sessionId)
})
test('cancels before spawn and reaps a running child on iterator return', async t => {
  const f = await setup(t); if (!f) return
  const controller = new AbortController(); controller.abort()
  const events = await collect(f.agent.executeTask({ taskId: 'pre', input: 'HANG', model: f.profile }, { signal: controller.signal }))
  assert.equal(events.at(-1).type, 'cancelled'); assert.equal(f.spawnCount, 0)
  const iterator = f.agent.executeTask({ taskId: 'hang', input: 'HANG', model: f.profile })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'session'); await iterator.return()
  assert.equal((await collect(f.agent.executeTask({ taskId: 'after', input: 'NORMAL', model: f.profile }))).at(-1).type, 'assistant-complete')
})
test('handles spawn failure and state-save failure without reporting completion', async t => {
  const f = await setup(t); if (!f) return
  const agent = await createAgentPackageWithRuntime(f.options, { command: '/missing/roo', spawnProcess(_c, _a, options) { return spawn('/definitely/missing/roo-test-binary', [], options) } })
  t.after(() => agent.dispose())
  const failed = await collect(agent.executeTask({ taskId: 'missing', input: 'NORMAL', model: f.profile }))
  assert.equal(failed.at(-1).type, 'error'); assert(!failed.some(event => event.type === 'assistant-complete'))
  await mkdir(join(f.options.stateDir, 'roo-sessions.json'))
  const events = await collect(f.agent.executeTask({ taskId: 'save', input: 'NORMAL', model: f.profile }))
  assert.equal(events.at(-1).type, 'error'); assert(!events.some(event => event.type === 'assistant-complete'))
})
