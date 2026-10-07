import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (patch = {}) => ({ id: 'profile-a', provider: 'company-gateway', model: 'swe-model', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:4321/v1', ...patch })
async function fixture(t, { stateDir, workspace: workspaceInput, runtime } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-swe-agent-test-'))
  const workspace = workspaceInput ?? join(temp, 'workspace')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'probe.txt'), 'fixture')
  const agent = await createAgentPackageWithRuntime({ workspace, stateDir: stateDir ?? join(temp, 'state'), env: { MODEL_KEY: 'profile-secret', OPENAI_API_KEY: 'ambient-secret', TALENT_WORKER_RECORD: join(temp, 'record.ndjson') }, config: { cancelGraceMs: 800 } }, runtime ?? { command: process.execPath, argsPrefix: [new URL('./fake-worker.mjs', import.meta.url).pathname], spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp }
}
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }

test('forwards external profile and native action/result events without ambient keys', async t => {
  const { agent, temp } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'one', input: 'run', sessionId: 'same', model: profile() }))
  assert.deepEqual(events.slice(1).map(event => event.type), ['tool-call', 'tool-result', 'assistant-complete'])
  const record = JSON.parse((await readFile(join(temp, 'record.ndjson'), 'utf8')).trim())
  assert.equal(record.key, undefined)
  assert.equal(record.request.apiKey, 'profile-secret')
  assert.equal(record.request.model.baseUrl, profile().baseUrl)
  assert.equal(JSON.stringify(events).includes('profile-secret'), false)
  assert.equal(JSON.stringify(events).includes('ambient-secret'), false)
})

test('isolates durable history by host session and full model profile', async t => {
  const { agent, temp } = await fixture(t)
  await collect(agent.executeTask({ taskId: 'one', input: 'run', sessionId: 'same', model: profile() }))
  await collect(agent.executeTask({ taskId: 'two', input: 'run', sessionId: 'same', model: profile() }))
  await collect(agent.executeTask({ taskId: 'other', input: 'run', sessionId: 'same', model: profile({ model: 'other-model' }) }))
  const rows = (await readFile(join(temp, 'record.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].request.historyPath, rows[1].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[2].request.historyPath)
})

test('cancels its worker, redacts provider errors, and permits recovery', async t => {
  const { agent } = await fixture(t)
  const failure = await collect(agent.executeTask({ taskId: 'fail', input: 'FAIL', model: profile() }))
  assert(failure.some(event => event.type === 'error'))
  assert.equal(JSON.stringify(failure).includes('profile-secret'), false)
  const running = collect(agent.executeTask({ taskId: 'hang', input: 'HANG', model: profile() }))
  await new Promise(resolveWait => setTimeout(resolveWait, 30))
  await agent.cancelTask('hang')
  assert.equal((await running).at(-1).type, 'cancelled')
  assert.equal((await collect(agent.executeTask({ taskId: 'after', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('requires explicit supported host model profile', async t => {
  const { agent } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'missing', input: 'run' }), /model profile is required/)
  assert.throws(() => agent.executeTask({ taskId: 'protocol', input: 'run', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  assert.throws(() => agent.executeTask({ taskId: 'endpoint', input: 'run', model: profile({ baseUrl: 'https://user:pass@example.com/v1' }) }), /credential-free/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { provider: 'openai' } }, { command: process.execPath, spawnProcess: spawn }), /unsupported config key: provider/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { cancelGraceMs: 0 } }, { command: process.execPath, spawnProcess: spawn }), /cancelGraceMs must be an integer/)
})

test('accepts arbitrary provider labels, defaults base URL, and ignores profile display name', async t => {
  const { agent, temp } = await fixture(t)
  await collect(agent.executeTask({ taskId: 'default', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined, name: 'Friendly name' }) }))
  await collect(agent.executeTask({ taskId: 'same-route', sessionId: 'same', input: 'run', model: profile({ baseUrl: undefined, name: 'Different display name' }) }))
  const rows = (await readFile(join(temp, 'record.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].request.model.provider, 'company-gateway')
  assert.equal(rows[0].request.model.baseUrl, 'https://api.openai.com/v1')
  assert.equal(rows[0].request.historyPath, rows[1].request.historyPath)
})

test('isolates host session and model profile by workspace as well as session', async t => {
  const { agent, temp } = await fixture(t)
  const workspace2 = join(temp, 'workspace-two')
  await (await import('node:fs/promises')).mkdir(workspace2)
  const record = join(temp, 'record.ndjson')
  const second = await createAgentPackageWithRuntime({ workspace: workspace2, stateDir: join(temp, 'state'), env: { MODEL_KEY: 'profile-secret', TALENT_WORKER_RECORD: record } }, { command: process.execPath, argsPrefix: [new URL('./fake-worker.mjs', import.meta.url).pathname], spawnProcess: spawn })
  t.after(() => second.dispose())
  await collect(agent.executeTask({ taskId: 'a', sessionId: 'same', input: 'run', model: profile() }))
  await collect(second.executeTask({ taskId: 'b', sessionId: 'same', input: 'run', model: profile() }))
  const rows = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.notEqual(rows[0].request.historyPath, rows[1].request.historyPath)
  assert.notEqual(rows[0].request.hostSessionKey, rows[1].request.hostSessionKey)
})

test('rejects malformed, oversized, unsupported, incomplete and nonzero terminal streams, then recovers', async t => {
  const { agent } = await fixture(t)
  for (const [input, pattern] of [
    ['MALFORMED', /malformed NDJSON/], ['OVERSIZED', /line exceeds/], ['UNKNOWN_EVENT', /unsupported event type/],
    ['NO_TERMINAL', /without an assistant-complete/], ['COMPLETE_NONZERO', /exited with code 7/], ['AFTER_TERMINAL', /after a terminal event/],
  ]) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert(events.some(event => event.type === 'error' && pattern.test(event.message)), `${input} should produce a protocol error`)
    assert.notEqual(events.at(-1)?.type, 'assistant-complete', `${input} must not be reported as success`)
  }
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery-after-protocol', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('handles worker spawn errors without an unhandled child-process error', async t => {
  const { agent } = await fixture(t, { runtime: { command: '/definitely/missing/swe-agent-python', argsPrefix: [], spawnProcess: spawn } })
  const events = await collect(agent.executeTask({ taskId: 'missing-worker', input: 'run', model: profile() }))
  assert(events.some(event => event.type === 'error' && event.message.includes('could not run')))
})
