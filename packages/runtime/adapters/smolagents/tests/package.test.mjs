import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (patch = {}) => ({ id: 'profile-a', provider: 'gateway-label', model: 'exact-model-id', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:4321/v1', ...patch })
const runtime = { command: process.execPath, argsPrefix: [new URL('./fake-worker.mjs', import.meta.url).pathname], spawnProcess: spawn }
async function fixture(t, { workspace, stateDir, runtime: selectedRuntime } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-smolagents-test-'))
  const root = workspace ?? join(temp, 'workspace')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'probe.txt'), 'fixture')
  const record = join(temp, 'record.ndjson')
  const agent = await createAgentPackageWithRuntime({ workspace: root, stateDir: stateDir ?? join(temp, 'state'), env: { MODEL_KEY: 'mock-secret', OPENAI_API_KEY: 'ambient-secret', TALENT_WORKER_RECORD: record }, config: { cancelGraceMs: 800 } }, selectedRuntime ?? runtime)
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp, root, record }
}
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }

test('forwards native Python tool events while keeping secrets out of requests and events', async t => {
  const { agent, record } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'one', input: 'run', sessionId: 'same', model: profile() }))
  assert.deepEqual(events.slice(1).map(event => event.type), ['tool-call', 'tool-result', 'assistant-replace', 'assistant-complete'])
  const row = JSON.parse((await readFile(record, 'utf8')).trim())
  assert.equal(row.hasKey, true)
  assert.equal(row.request.apiKey, undefined)
  assert.equal(row.request.model.model, 'exact-model-id')
  assert.equal(row.request.model.provider, 'gateway-label')
  assert.equal(JSON.stringify(events).includes('mock-secret'), false)
  assert.equal(JSON.stringify(events).includes('ambient-secret'), false)
})

test('defaults base URL, ignores display name, and isolates by workspace/session/full profile', async t => {
  const { agent, temp, record } = await fixture(t)
  const otherWorkspace = join(temp, 'other-workspace')
  await mkdir(otherWorkspace)
  const otherAgent = await createAgentPackageWithRuntime({ workspace: otherWorkspace, stateDir: join(temp, 'state'), env: { MODEL_KEY: 'mock-secret', TALENT_WORKER_RECORD: record } }, runtime)
  t.after(() => otherAgent.dispose())
  await collect(agent.executeTask({ taskId: 'one', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined, name: 'first name' }) }))
  await collect(agent.executeTask({ taskId: 'two', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined, name: 'second name' }) }))
  await collect(agent.executeTask({ taskId: 'three', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined, model: 'different-model' }) }))
  await collect(otherAgent.executeTask({ taskId: 'four', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined }) }))
  const rows = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].request.model.baseUrl, 'https://api.openai.com/v1')
  assert.equal(rows[0].request.historyPath, rows[1].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[2].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[3].request.historyPath)
})

test('cancels worker, suppresses post-cancel events, redacts provider failure, and recovers', async t => {
  const { agent } = await fixture(t)
  const failure = await collect(agent.executeTask({ taskId: 'fail', input: 'FAIL', model: profile() }))
  assert(failure.some(event => event.type === 'error'))
  assert.equal(JSON.stringify(failure).includes('mock-secret'), false)
  const stream = collect(agent.executeTask({ taskId: 'hang', input: 'HANG', model: profile() }))
  await new Promise(resolve => setTimeout(resolve, 50))
  await agent.cancelTask('hang')
  const cancelled = await stream
  assert.equal(cancelled.at(-1).type, 'cancelled')
  assert.equal(cancelled.some(event => event.type === 'assistant-replace'), false)
  assert.equal((await collect(agent.executeTask({ taskId: 'recover', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('rejects malformed, oversized, unsupported, missing-terminal and post-terminal worker streams', async t => {
  const { agent } = await fixture(t)
  for (const [input, pattern] of [
    ['MALFORMED', /malformed NDJSON/], ['OVERSIZED', /line exceeds/], ['UNKNOWN', /unsupported event type/],
    ['NO_TERMINAL', /without an assistant-complete/], ['COMPLETE_NONZERO', /exited with code 7/], ['AFTER_TERMINAL', /after a terminal event/],
  ]) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert(events.some(event => event.type === 'error' && pattern.test(event.message)), `${input} should be rejected`)
    assert.notEqual(events.at(-1)?.type, 'assistant-complete')
  }
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('handles spawn ENOENT and validates external model/config contracts', async t => {
  const { agent } = await fixture(t, { runtime: { command: '/missing/smolagents-python', spawnProcess: spawn } })
  const events = await collect(agent.executeTask({ taskId: 'missing', input: 'run', model: profile() }))
  assert(events.some(event => event.type === 'error' && event.message.includes('could not run')))
  assert.throws(() => agent.executeTask({ taskId: 'unsupported', input: 'run', model: profile({ protocol: 'other' }) }), /unsupported model profile protocol/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { model: 'in-config' } }, runtime), /unsupported config key: model/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { cancelGraceMs: 0 } }, runtime), /cancelGraceMs must be an integer/)
})
