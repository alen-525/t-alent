import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = overrides => ({ id: 'open-profile', provider: 'openai-compatible', model: 'model-x', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:1234/v1', ...overrides })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'talent-openhands-test-'))
  const agent = await createAgentPackageWithRuntime({ workspace: dir, stateDir: join(dir, 'state'), env: { MODEL_KEY: 'test-key-secret', OPENAI_API_KEY: 'ambient-secret' }, config: { cancelGraceMs: 100 } }, { python: process.execPath, pythonArgs: [], worker: new URL('./fake-worker.mjs', import.meta.url).pathname, spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { agent, dir }
}
const collect = async iterable => { const result = []; for await (const event of iterable) result.push(event); return result }

test('maps original SDK worker records to Harness events with a host-supplied route', async t => {
  const { agent } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'one', sessionId: 'conversation-A', input: 'do work', model: profile() }))
  assert.equal(events[0].type, 'session')
  assert.equal(events.find(event => event.type === 'tool-call').name, 'TerminalTool')
  assert.equal(events.find(event => event.type === 'tool-result').output, 'file proof')
  assert.equal(events.at(-1).type, 'assistant-complete')
})

test('isolates history by profile, rejects wrong protocol, and requires terminal success', async t => {
  const { agent } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  const a = await collect(agent.executeTask({ taskId: 'a', sessionId: 'same', input: 'ok', model: profile() }))
  const b = await collect(agent.executeTask({ taskId: 'b', sessionId: 'same', input: 'ok', model: profile({ model: 'other' }) }))
  assert.notEqual(a[0].sessionId, b[0].sessionId)
  const incomplete = await collect(agent.executeTask({ taskId: 'missing', input: 'no-done', model: profile() }))
  assert(incomplete.some(event => event.type === 'error'))
  assert.equal(incomplete.some(event => event.type === 'assistant-complete'), false)
})

test('redacts worker errors and cancellation cleans up the child and adapter', async t => {
  const { agent } = await fixture(t)
  const failed = await collect(agent.executeTask({ taskId: 'failure', input: 'failure', model: profile() }))
  assert.equal(JSON.stringify(failed).includes('test-key-secret'), false)
  const stream = agent.executeTask({ taskId: 'cancel', input: 'hang', model: profile() })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value.type, 'session')
  await stream.return()
  assert.equal((await collect(agent.executeTask({ taskId: 'recovered', input: 'ok', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('bounds malformed and oversized NDJSON and handles early worker exit without crashing', async t => {
  const { agent } = await fixture(t)
  for (const input of ['malformed', 'oversized', 'startup-exit']) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert.equal(events.at(-1).type, 'error', `${input}: ${JSON.stringify(events.slice(-2))}`)
    assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  }
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery', input: 'ok', model: profile() }))).at(-1).type, 'assistant-complete')
})
