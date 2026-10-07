import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (changes = {}) => ({ id: 'profile', provider: 'mock', model: 'model-x', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:1234/v1', ...changes })
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-qwen-test-'))
  const agent = await createAgentPackageWithRuntime({ workspace: temp, stateDir: join(temp, 'state'), env: { MODEL_KEY: 'secret-test-key', OPENAI_API_KEY: 'unrelated-key', TEST_CAPTURE: join(temp, 'capture.json') } }, { command: process.execPath, bin: new URL('./fake-qwen.mjs', import.meta.url).pathname, spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp }
}
const collect = async stream => { const result = []; for await (const event of stream) result.push(event); return result }

test('pins host profile, uses upstream CLI stream-json, and maps session/tool/text events', async t => {
  const { agent, temp } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'task-a', sessionId: 'chat-a', input: 'inspect workspace', model: profile() }))
  assert.equal(events.find(e => e.type === 'session').sessionId, 'qwen-session-fixture')
  assert.equal(events.find(e => e.type === 'tool-call').name, 'read_file')
  assert.equal(events.find(e => e.type === 'tool-result').output, 'fixture contents')
  assert.equal(events.at(-1).type, 'assistant-complete')
  const record = JSON.parse(await readFile(join(temp, 'capture.json'), 'utf8'))
  assert.equal(record.key, 'secret-test-key'); assert.equal(record.baseUrl, profile().baseUrl)
  assert.equal(record.args[record.args.indexOf('--output-format') + 1], 'stream-json')
  assert.equal(record.args[record.args.indexOf('--auth-type') + 1], 'openai')
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'model-x')
  assert(record.args.includes('--bare'))
  assert.equal(record.modelEnv, undefined)
  assert.equal(record.home.includes('state/homes/'), true)
  assert.equal(record.key, 'secret-test-key')
})

test('persists session by host session and complete route fingerprint', async t => {
  const { agent, temp } = await fixture(t)
  await collect(agent.executeTask({ taskId: 'one', sessionId: 'same', input: 'first', model: profile() }))
  await collect(agent.executeTask({ taskId: 'two', sessionId: 'same', input: 'second', model: profile() }))
  const record = JSON.parse(await readFile(join(temp, 'capture.json'), 'utf8'))
  assert.equal(record.args[record.args.indexOf('--resume') + 1], 'qwen-session-fixture')
  const before = JSON.parse(await readFile(join(temp, 'state/qwen-sessions.json'), 'utf8'))
  await collect(agent.executeTask({ taskId: 'three', sessionId: 'same', input: 'new route', model: profile({ model: 'other' }) }))
  const after = JSON.parse(await readFile(join(temp, 'state/qwen-sessions.json'), 'utf8'))
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1)
})

test('redacts diagnostics, rejects unsupported routes, and cancellation releases the child', async t => {
  const { agent, temp } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  const failed = await collect(agent.executeTask({ taskId: 'fail', input: 'FAIL', model: profile() }))
  assert.equal(JSON.stringify(failed).includes('secret-test-key'), false)
  const iter = agent.executeTask({ taskId: 'cancel', input: 'HANG', model: profile() })
  const events = []
  const read = (async () => { for await (const event of iter) events.push(event) })()
  let started = false
  for (let i = 0; i < 100; i++) {
    try { const r = JSON.parse(await readFile(join(temp, 'capture.json'), 'utf8')); if (r.args.includes('HANG')) { started = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(started, true, 'HANG child must write its started marker before cancellation')
  await agent.cancelTask('cancel'); await read
  assert(events.some(e => e.type === 'cancelled'))
  assert.equal((await collect(agent.executeTask({ taskId: 'after', input: 'ok', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('does not report completion without Qwen successful terminal status', async t => {
  const { agent } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'no-status', input: 'NO_STATUS', model: profile() }))
  assert(events.some(e => e.type === 'error'))
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.some(e => e.type === 'assistant-complete'), false)
})

test('rejects malformed, unknown, and untyped JSONL records', async t => {
  const { agent } = await fixture(t)
  for (const input of ['BAD', 'UNKNOWN', 'MISSING_TYPE']) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert(events.some(e => e.type === 'error'), `${input} should report a protocol error`)
    assert.equal(events.some(e => e.type === 'assistant-complete'), false)
  }
})

test('abort before spawn and iterator return each release only the owned Qwen child', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'talent-qwen-start-cancel-'))
  let release, entered, spawnCalls = 0
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const agent = await createAgentPackageWithRuntime({ workspace: temp, stateDir: join(temp, 'state'), env: { MODEL_KEY: 'secret-test-key' } }, {
    command: process.execPath,
    bin: new URL('./fake-qwen.mjs', import.meta.url).pathname,
    spawnProcess: (...args) => { spawnCalls++; return spawn(...args) },
    beforeSpawn: async () => { entered(); await gate },
  })
  try {
    const controller = new AbortController()
    const stream = agent.executeTask({ taskId: 'start-cancel', input: 'wait', model: profile() }, { signal: controller.signal })
    const result = collect(stream)
    await enteredPromise; controller.abort(); release()
    const events = await result
    assert.equal(spawnCalls, 0)
    assert(events.some(e => e.type === 'cancelled'))

    const iter = agent.executeTask({ taskId: 'iterator-return', input: 'RETURN_HANG', model: profile() })[Symbol.asyncIterator]()
    const first = await iter.next()
    assert.equal(first.value.type, 'session')
    await iter.return()
    assert.equal((await collect(agent.executeTask({ taskId: 'recovered', input: 'ok', model: profile() }))).at(-1).type, 'assistant-complete')
  } finally { await agent.dispose(); await rm(temp, { recursive: true, force: true }) }
})

test('allows OPENAI_API_KEY as the host profile credential reference', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'talent-qwen-openai-key-'))
  const agent = await createAgentPackageWithRuntime({ workspace: temp, stateDir: join(temp, 'state'), env: { OPENAI_API_KEY: 'host-openai-key', TEST_CAPTURE: join(temp, 'capture.json') } }, {
    command: process.execPath, bin: new URL('./fake-qwen.mjs', import.meta.url).pathname, spawnProcess: spawn,
  })
  try {
    const events = await collect(agent.executeTask({ taskId: 'host-key', input: 'ok', model: profile({ apiKeyEnv: 'OPENAI_API_KEY' }) }))
    assert.equal(events.at(-1).type, 'assistant-complete')
    assert.equal(JSON.parse(await readFile(join(temp, 'capture.json'), 'utf8')).key, 'host-openai-key')
  } finally { await agent.dispose(); await rm(temp, { recursive: true, force: true }) }
})
