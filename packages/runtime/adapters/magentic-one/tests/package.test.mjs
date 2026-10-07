import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (patch = {}) => ({ id: 'profile-a', provider: 'arbitrary-provider', model: 'exact/arbitrary:model', protocol: 'openai-chat-completions', apiKeyEnv: 'SELECTED_AUTH', baseUrl: 'http://127.0.0.1:4321/v1', ...patch })
const runtime = { command: process.execPath, argsPrefix: [new URL('./fake-worker.mjs', import.meta.url).pathname], spawnProcess: spawn }
async function fixture(t, { workspace, stateDir, runtime: selectedRuntime } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-magentic-one-test-'))
  const root = workspace ?? join(temp, 'workspace')
  await mkdir(root, { recursive: true })
  const record = join(temp, 'record.ndjson')
  const agent = await createAgentPackageWithRuntime({ workspace: root, stateDir: stateDir ?? join(temp, 'state'), env: { SELECTED_AUTH: 'mock-secret', OPENAI_API_KEY: 'ambient-secret', AWS_ACCESS_KEY_ID: 'ambient-cloud-credential', TALENT_WORKER_RECORD: record }, config: { cancelGraceMs: 800 } }, selectedRuntime ?? runtime)
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp, root, record }
}
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }

test('forwards native team events and keeps selected/custom credentials outside worker requests and events', async t => {
  const { agent, record } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'one', input: 'run', sessionId: 'same', model: profile() }))
  assert.deepEqual(events.slice(1).map(event => event.type), ['harness-event', 'assistant-replace', 'assistant-complete'])
  assert.equal(events[1].event.agent, 'ComputerTerminal')
  const row = JSON.parse((await readFile(record, 'utf8')).trim())
  assert.equal(row.hasKey, true)
  assert.equal(row.selectedKeyPresent, false)
  assert.equal(row.ambientCloudKeyPresent, false)
  assert.match(row.userProfile, /profiles/)
  assert.equal(row.userProfile, row.home)
  assert.equal(row.browser, '/usr/bin/true')
  assert.equal(row.request.model.model, 'exact/arbitrary:model')
  assert.equal(row.request.model.provider, 'arbitrary-provider')
  assert.equal(row.request.model.apiKey, undefined)
  assert.equal(JSON.stringify(events).includes('mock-secret'), false)
  assert.equal(JSON.stringify(events).includes('ambient-secret'), false)
})

test('uses the default base URL and isolates full profile, workspace and host session', async t => {
  const { agent, temp, record } = await fixture(t)
  const other = await createAgentPackageWithRuntime({ workspace: join(temp, 'workspace-two'), stateDir: join(temp, 'state'), env: { SELECTED_AUTH: 'mock-secret', TALENT_WORKER_RECORD: record } }, runtime)
  await mkdir(join(temp, 'workspace-two'))
  t.after(() => other.dispose())
  await collect(agent.executeTask({ taskId: 'one', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'first label' }) }))
  await collect(agent.executeTask({ taskId: 'two', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'first label' }) }))
  await collect(agent.executeTask({ taskId: 'name', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'second label' }) }))
  await collect(agent.executeTask({ taskId: 'three', input: 'run', sessionId: 'other-session', model: profile({ baseUrl: undefined, name: 'first label' }) }))
  await collect(agent.executeTask({ taskId: 'four', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'first label', model: 'different-model' }) }))
  await collect(agent.executeTask({ taskId: 'provider', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'first label', provider: 'different-provider' }) }))
  await collect(other.executeTask({ taskId: 'five', input: 'run', sessionId: 'same', model: profile({ baseUrl: undefined, name: 'first label' }) }))
  const rows = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].request.model.baseUrl, 'https://api.openai.com/v1')
  assert.equal(rows[0].request.historyPath, rows[1].request.historyPath)
  assert.equal(rows[0].request.historyPath, rows[2].request.historyPath, 'display-only model name should not split native history')
  assert.notEqual(rows[0].request.historyPath, rows[3].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[4].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[5].request.historyPath)
  assert.notEqual(rows[0].request.historyPath, rows[6].request.historyPath)
})

test('cancels and recovers; provider error is redacted', async t => {
  const { agent } = await fixture(t)
  const failed = await collect(agent.executeTask({ taskId: 'fail', input: 'FAIL', model: profile() }))
  assert(failed.some(event => event.type === 'error'))
  assert.equal(JSON.stringify(failed).includes('mock-secret'), false)
  const stream = collect(agent.executeTask({ taskId: 'hang', input: 'HANG', model: profile() }))
  await new Promise(resolve => setTimeout(resolve, 50))
  await agent.cancelTask('hang')
  assert.equal((await stream).at(-1).type, 'cancelled')
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('rejects malformed, oversized, unknown, no-terminal, post-terminal and nonzero worker outcomes', async t => {
  const { agent } = await fixture(t)
  for (const [input, pattern] of [
    ['MALFORMED', /malformed NDJSON/], ['OVERSIZED', /line exceeds/], ['UNKNOWN', /unsupported event type/],
    ['NO_TERMINAL', /without a native team completion/], ['COMPLETE_NONZERO', /exited with code 7/], ['AFTER_TERMINAL', /after a terminal event/],
  ]) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert(events.some(event => event.type === 'error' && pattern.test(event.message)), `${input} should be rejected`)
    assert.notEqual(events.at(-1)?.type, 'assistant-complete')
  }
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery', input: 'run', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('handles worker spawn failure and validates model/config protocol boundary', async t => {
  const { agent } = await fixture(t, { runtime: { command: '/missing/autogen-python', spawnProcess: spawn } })
  const events = await collect(agent.executeTask({ taskId: 'missing', input: 'run', model: profile() }))
  assert(events.some(event => event.type === 'error' && event.message.includes('could not run')))
  assert.throws(() => agent.executeTask({ taskId: 'unsupported', input: 'run', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { model: 'in-config' } }, runtime), /unsupported config key: model/)
  await assert.rejects(createAgentPackageWithRuntime({ workspace: '/tmp', stateDir: '/tmp/state', config: { cancelGraceMs: 0 } }, runtime), /cancelGraceMs must be an integer/)
})
