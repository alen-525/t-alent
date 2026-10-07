import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = { id: 'local', name: 'Profile label', provider: 'any compatible provider', model: 'org/model-v2', protocol: 'openai-chat-completions', apiKeyEnv: 'NANOBOT_TEST_KEY', baseUrl: 'http://127.0.0.1:9314/v1' }
const worker = new URL('./fixtures/fake-worker.mjs', import.meta.url).pathname

async function setup(t, mode) {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-nanobot-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const record = join(temp, 'record.jsonl')
  const options = { workspace: temp, stateDir: join(temp, 'state'), env: { NANOBOT_TEST_KEY: 'nanobot-secret-marker', ANOTHER_API_KEY: 'ambient-secret', OPENAI_API_BASE: 'http://ambient.invalid/v1', FAKE_MODE: mode ?? '', FAKE_RECORD: record }, config: { cancelGraceMs: 100 } }
  const runtime = { command: process.execPath, args: [worker], spawnProcess(command, args, opts) { return spawn(command, args, opts) } }
  return { temp, record, options, runtime }
}
async function collect(agent, taskId = 'one', model = profile, sessionId = 'conversation') { const events = []; for await (const event of agent.executeTask({ taskId, sessionId, model, input: 'Read sample.txt and report its contents.' })) events.push(event); return events }

test('streams native coding events with an arbitrary provider label and exact host model ID', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent)
  await agent.dispose()
  assert(events.some(e => e.type === 'tool-call' && e.name === 'read_file'))
  assert(events.some(e => e.type === 'tool-result' && e.output === 'sample [redacted]'))
  assert.equal(events.at(-1).type, 'assistant-complete')
  assert.equal(JSON.stringify(events).includes('nanobot-secret-marker'), false)
  const launch = JSON.parse((await readFile(record, 'utf8')).trim())
  assert.equal(launch.request.model, 'org/model-v2')
  assert.equal(launch.request.provider, 'any compatible provider')
  assert.equal(launch.envKey, 'nanobot-secret-marker')
  assert.equal(launch.inherited, undefined)
  assert.equal(launch.browser, '/usr/bin/true')
  assert.equal(JSON.stringify(launch.request).includes('nanobot-secret-marker'), false)
})

test('isolates native history by workspace and full routing while ignoring display name', async t => {
  const { options, runtime, record } = await setup(t)
  const a = await createAgentPackageWithRuntime(options, runtime); await collect(a, 'a', profile, 'same'); await a.dispose()
  const b = await createAgentPackageWithRuntime(options, runtime); await collect(b, 'b', { ...profile, name: 'Renamed' }, 'same'); await collect(b, 'c', { ...profile, model: 'another/model' }, 'same'); await b.dispose()
  const otherWorkspace = join(options.workspace, 'other'); await mkdir(otherWorkspace)
  const c = await createAgentPackageWithRuntime({ ...options, workspace: otherWorkspace }, runtime); await collect(c, 'd', profile, 'same'); await c.dispose()
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line).request)
  assert.equal(requests[0].profileDir, requests[1].profileDir)
  assert.notEqual(requests[0].profileDir, requests[2].profileDir)
  assert.notEqual(requests[0].profileDir, requests[3].profileDir)
  assert.equal(requests[0].sessionKey, requests[1].sessionKey)
  assert.notEqual(requests[0].sessionKey, requests[2].sessionKey)
})

test('rejects unsupported protocols and missing keys before starting a process', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: { ...profile, protocol: 'anthropic' } }), /supports only/)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: { ...profile, apiKeyEnv: 'MISSING_KEY' } }), /missing/)
  await agent.dispose(); await assert.rejects(readFile(record), { code: 'ENOENT' })
})

test('redacts upstream provider errors and never reports false completion', async t => {
  const { options, runtime } = await setup(t, 'failure')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent); await agent.dispose()
  assert(events.some(e => e.type === 'error' && e.message === '401 [redacted]'))
  assert.equal(events.some(e => e.type === 'assistant-complete'), false)
})

test('rejects malformed, oversized, and incomplete worker streams', async t => {
  for (const mode of ['malformed', 'oversized', 'no-complete']) {
    const { options, runtime } = await setup(t, mode)
    const agent = await createAgentPackageWithRuntime(options, runtime)
    const events = await collect(agent); await agent.dispose()
    assert(events.some(e => e.type === 'error'), mode)
    assert.equal(events.some(e => e.type === 'assistant-complete'), false, mode)
  }
})

test('cancellation stops the process group and emits cancelled', async t => {
  const { options, runtime } = await setup(t, 'hang')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const controller = new AbortController()
  const iterator = agent.executeTask({ taskId: 'cancel', sessionId: 'cancel', input: 'wait', model: profile }, { signal: controller.signal })[Symbol.asyncIterator]()
  await new Promise(resolve => setTimeout(resolve, 100)); controller.abort()
  const events = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
  await agent.dispose()
  assert(events.some(e => e.type === 'cancelled'))
})

test('pre-cancelled task does not launch, missing runtime reports spawn failure', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const controller = new AbortController(); controller.abort()
  const events = []; for await (const event of agent.executeTask({ taskId: 'skip', input: 'skip', model: profile }, { signal: controller.signal })) events.push(event)
  await agent.dispose(); await assert.rejects(readFile(record), { code: 'ENOENT' })
  const broken = await createAgentPackageWithRuntime(options, { command: join(options.tempDir ?? options.workspace, 'missing-python'), args: [worker], spawnProcess(command, args, opts) { return spawn(command, args, opts) } })
  const failure = await collect(broken, 'missing-runtime'); await broken.dispose()
  assert(failure.some(event => event.type === 'error'))
})
