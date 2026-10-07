import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = { id: 'local', name: 'Friendly display name', provider: 'custom arbitrary provider', model: 'openai/team/model-v2', protocol: 'openai-chat-completions', apiKeyEnv: 'HERMES_TEST_KEY', baseUrl: 'http://127.0.0.1:9314/v1' }
const worker = new URL('./fixtures/fake-worker.mjs', import.meta.url).pathname
async function setup(t, mode) {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-hermes-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const record = join(temp, 'record.jsonl')
  const options = { workspace: temp, stateDir: join(temp, 'state'), env: { HERMES_TEST_KEY: 'hermes-secret-marker', HERMES_TEST_ALIAS: 'hermes-secret-marker', OPENAI_API_KEY: 'ambient-secret', FAKE_MODE: mode ?? '', FAKE_RECORD: record }, config: { cancelGraceMs: 100 } }
  const runtime = { command: process.execPath, args: [worker], source: join(temp, 'source'), spawnProcess(command, args, opts) { return spawn(command, args, opts) } }
  return { temp, record, options, runtime }
}
async function collect(agent, taskId = 'one', model = profile, sessionId = 'conversation') { const events = []; for await (const event of agent.executeTask({ taskId, sessionId, model, input: 'Observe the project using native coding tools.' })) events.push(event); return events }

test('bridges native coding events without changing arbitrary host routing or exposing credentials', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent); await agent.dispose()
  assert(events.some(e => e.type === 'tool-call' && e.name === 'terminal'))
  assert(events.some(e => e.type === 'tool-result' && e.output === 'sample [redacted]'))
  assert.equal(events.at(-1).type, 'assistant-complete')
  assert.equal(JSON.stringify(events).includes('hermes-secret-marker'), false)
  const launch = JSON.parse((await readFile(record, 'utf8')).trim())
  assert.equal(launch.request.model, profile.model)
  assert.equal(launch.request.provider, profile.provider)
  assert.equal(launch.envKey, 'hermes-secret-marker')
  assert.equal(launch.alias, undefined)
  assert.equal(launch.inherited, undefined)
  assert.equal(launch.browser, '/usr/bin/true')
  assert.equal(JSON.stringify(launch.request).includes('hermes-secret-marker'), false)
})

test('isolates native history by workspace and complete route but ignores display-name changes', async t => {
  const { options, runtime, record } = await setup(t)
  const a = await createAgentPackageWithRuntime(options, runtime); await collect(a, 'a', profile, 'same'); await a.dispose()
  const b = await createAgentPackageWithRuntime(options, runtime); await collect(b, 'b', { ...profile, name: 'Renamed' }, 'same'); await collect(b, 'c', { ...profile, model: 'other/model' }, 'same'); await b.dispose()
  const other = join(options.workspace, 'other'); await mkdir(other)
  const c = await createAgentPackageWithRuntime({ ...options, workspace: other }, runtime); await collect(c, 'd', profile, 'same'); await c.dispose()
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line).request)
  assert.equal(requests[0].profileDir, requests[1].profileDir)
  assert.notEqual(requests[0].profileDir, requests[2].profileDir)
  assert.notEqual(requests[0].profileDir, requests[3].profileDir)
  assert.equal(requests[0].sessionKey, requests[1].sessionKey)
  assert.notEqual(requests[0].sessionKey, requests[2].sessionKey)
})

test('rejects invalid profiles, absent keys, and invalid numeric config', async t => {
  const { options, runtime, record } = await setup(t)
  await assert.rejects(createAgentPackageWithRuntime({ ...options, config: { cancelGraceMs: 0 } }, runtime), /cancelGraceMs/)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'x', model: { ...profile, protocol: 'unsupported' } }), /supports only/)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'x', model: { ...profile, apiKeyEnv: 'MISSING_KEY' } }), /missing/)
  await agent.dispose(); await assert.rejects(readFile(record), { code: 'ENOENT' })
})

test('redacts provider failures and never emits false completion', async t => {
  const { options, runtime } = await setup(t, 'failure')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent); await agent.dispose()
  assert(events.some(event => event.type === 'error' && event.message === '401 [redacted]'))
  assert.equal(events.some(event => event.type === 'assistant-complete'), false)
})

test('rejects malformed, oversized, and incomplete NDJSON output', async t => {
  for (const mode of ['malformed', 'oversized', 'no-complete']) {
    const { options, runtime } = await setup(t, mode)
    const agent = await createAgentPackageWithRuntime(options, runtime)
    const events = await collect(agent); await agent.dispose()
    assert(events.some(event => event.type === 'error'), mode)
    assert.equal(events.some(event => event.type === 'assistant-complete'), false, mode)
  }
})

test('cancellation terminates child and reports cancelled', async t => {
  const { options, runtime } = await setup(t, 'hang')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const controller = new AbortController()
  const iterator = agent.executeTask({ taskId: 'cancel', input: 'wait', model: profile }, { signal: controller.signal })[Symbol.asyncIterator]()
  await new Promise(resolve => setTimeout(resolve, 100)); controller.abort()
  const events = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
  await agent.dispose(); assert(events.some(event => event.type === 'cancelled'))
})

test('pre-cancel avoids spawn and missing executable returns a spawn error', async t => {
  const { options, runtime, record, temp } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const controller = new AbortController(); controller.abort()
  const events = []; for await (const event of agent.executeTask({ taskId: 'skip', input: 'skip', model: profile }, { signal: controller.signal })) events.push(event)
  await agent.dispose(); await assert.rejects(readFile(record), { code: 'ENOENT' })
  const broken = await createAgentPackageWithRuntime(options, { command: join(temp, 'missing-python'), args: [worker], source: runtime.source, spawnProcess: spawn })
  const failure = await collect(broken, 'missing-runtime'); await broken.dispose()
  assert(failure.some(event => event.type === 'error'))
})
