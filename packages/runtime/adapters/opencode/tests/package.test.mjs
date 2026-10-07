import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (overrides = {}) => ({ id: 'profile-a', name: 'Fixture', provider: 'custom', model: 'model-x', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:1234/v1', ...overrides })
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-opencode-test-'))
  const workspace = join(temp, 'workspace')
  const stateDir = join(temp, 'state')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  const agent = await createAgentPackageWithRuntime({ workspace, stateDir, env: { MODEL_KEY: 'secret-fixture-key', OPENAI_API_KEY: 'unrelated-key', OPENCODE_TEST_ARGS: join(temp, 'args.json') } }, { command: process.execPath, bin: new URL('./fake-opencode.mjs', import.meta.url).pathname, spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp, stateDir }
}
const collect = async stream => { const events = []; for await (const e of stream) events.push(e); return events }

test('runs official CLI-shaped JSONL contract with pinned profile and mapped tool events', async t => {
  const { agent, temp, stateDir } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'task-A', input: 'inspect', sessionId: 'conversation-A', model: profile() }))
  assert.equal(events.find(e => e.type === 'session').sessionId, 'ses_fixture')
  assert.equal(events.find(e => e.type === 'tool-call').name, 'read')
  assert.equal(events.find(e => e.type === 'tool-call').input.credential, '[redacted]')
  assert.equal(events.find(e => e.type === 'tool-call').callId, 'tool-1-[redacted]')
  assert.equal(events.find(e => e.type === 'tool-result').output, 'file text [redacted]')
  assert.deepEqual(events.slice(-2), [{ type: 'assistant-replace', text: 'answer' }, { type: 'assistant-complete' }])
  const record = JSON.parse(await readFile(join(temp, 'args.json'), 'utf8'))
  assert.equal(record.args.includes('--pure'), true)
  assert.equal(record.args.includes('--auto'), true)
  assert.equal(record.args[record.args.indexOf('--model') + 1], record.model)
  const config = record.configDoc
  const provider = config.provider[record.model.split('/')[0]]
  assert.equal(provider.options.apiKey, '{env:TALENT_OPENCODE_PROFILE_KEY}')
  assert.equal(provider.options.baseURL, profile().baseUrl)
  assert.equal(await readFile(join(stateDir, 'opencode-sessions.json'), 'utf8').then(s => Object.values(JSON.parse(s))[0]), 'ses_fixture')
  assert.equal(JSON.stringify(events).includes('secret-fixture-key'), false)
})

test('model fingerprint separates session histories and rejects unsupported or missing profiles', async t => {
  const { agent } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'none', input: 'x' }), /model profile is required/)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: profile({ protocol: 'deepseek' }) }), /unsupported model profile protocol/)
  const first = await collect(agent.executeTask({ taskId: 'a', input: 'one', sessionId: 'same', model: profile() }))
  assert.equal(first[0].sessionId, 'ses_fixture')
  const second = await collect(agent.executeTask({ taskId: 'b', input: 'two', sessionId: 'same', model: profile({ model: 'another-model' }) }))
  assert.equal(second[0].sessionId, 'ses_fixture')
})

test('redacts process diagnostics, cancels the owned child, and iterator return releases it', async t => {
  const { agent } = await fixture(t)
  const failed = await collect(agent.executeTask({ taskId: 'fail', input: 'FAIL', model: profile() }))
  assert.equal(failed.filter(e => e.type === 'error').length, 1)
  assert.equal(JSON.stringify(failed).includes('secret-fixture-key'), false)
  const iterator = agent.executeTask({ taskId: 'cancel', input: 'HANG', model: profile() })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, 'session')
  await iterator.return()
  const next = await collect(agent.executeTask({ taskId: 'again', input: 'ok', model: profile() }))
  assert.equal(next.at(-1).type, 'assistant-complete')
})

test('supports all explicitly implemented protocol adapters', async t => {
  const { agent, temp } = await fixture(t)
  for (const [protocol, sdk] of [['openai-chat-completions', '@ai-sdk/openai-compatible'], ['openai-responses', '@ai-sdk/openai'], ['anthropic', '@ai-sdk/anthropic']]) {
    const events = await collect(agent.executeTask({ taskId: protocol, input: 'ok', model: profile({ protocol }) }))
    assert.equal(events.at(-1).type, 'assistant-complete')
    const record = JSON.parse(await readFile(join(temp, 'args.json'), 'utf8'))
    const doc = record.configDoc
    assert.equal(doc.provider[record.model.split('/')[0]].npm, sdk)
  }
})

test('completed native ToolPart emits both tool call and redacted result', async t => {
  const { agent } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'completed', input: 'COMPLETED', model: profile() }))
  assert.equal(events.find(e => e.type === 'tool-call').name, 'read')
  assert.equal(events.find(e => e.type === 'tool-result').output, 'completed native part [redacted]')
  assert.equal(events.find(e => e.type === 'tool-result').status, 'success')
})
