import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = (patch = {}) => ({ id: 'profile-a', provider: 'openai', model: 'model-x', protocol: 'openai-chat-completions', apiKeyEnv: 'MODEL_KEY', baseUrl: 'http://127.0.0.1:1234/v1', ...patch })
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'talent-mini-swe-test-'))
  const workspace = join(temp, 'workspace')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(workspace); await writeFile(join(workspace, 'file.txt'), 'fixture')
  const agent = await createAgentPackageWithRuntime({ workspace, stateDir: join(temp, 'state'), env: { MODEL_KEY: 'profile-secret', OPENAI_API_KEY: 'ambient-secret', MINI_SWE_TEST_RECORD: join(temp, 'record.ndjson') }, config: { cancelGraceMs: 800 } }, { command: process.execPath, argsPrefix: [new URL('./fake-worker.mjs', import.meta.url).pathname], spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { agent, temp }
}
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }

test('forwards task profile through private worker env and maps bash events', async t => {
  const { agent, temp } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'task-1', input: 'go', sessionId: 'conversation', model: profile() }))
  assert.deepEqual(events.slice(1).map(x => x.type), ['tool-call', 'tool-result', 'assistant-replace', 'assistant-complete'])
  const record = JSON.parse((await readFile(join(temp, 'record.ndjson'), 'utf8')).trim())
  assert.equal(record.key, undefined)
  assert.equal(record.request.apiKey, 'profile-secret')
  assert.equal(record.request.model.baseUrl, profile().baseUrl)
  assert.equal(JSON.stringify(events).includes('profile-secret'), false)
  assert.equal(JSON.stringify(events).includes('ambient-secret'), false)
  assert.equal(record.request.hostSessionKey, events[0].sessionId)
})

test('keys durable sessions by host conversation and full route fingerprint', async t => {
  const { agent, temp } = await fixture(t)
  const first = await collect(agent.executeTask({ taskId: 'one', input: 'go', sessionId: 'same', model: profile() }))
  const same = await collect(agent.executeTask({ taskId: 'two', input: 'go', sessionId: 'same', model: profile() }))
  const other = await collect(agent.executeTask({ taskId: 'three', input: 'go', sessionId: 'same', model: profile({ model: 'other-model' }) }))
  assert.equal(first[0].sessionId, same[0].sessionId)
  assert.notEqual(first[0].sessionId, other[0].sessionId)
  const records = (await readFile(join(temp, 'record.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records[0].request.historyPath, records[1].request.historyPath)
  assert.notEqual(records[0].request.historyPath, records[2].request.historyPath)
})

test('cancels only its worker and redacts errors', async t => {
  const { agent } = await fixture(t)
  const bad = await collect(agent.executeTask({ taskId: 'bad', input: 'ERROR', model: profile() }))
  assert(bad.some(event => event.type === 'error'))
  assert.equal(JSON.stringify(bad).includes('profile-secret'), false)
  const run = collect(agent.executeTask({ taskId: 'cancel', input: 'HANG', model: profile() }))
  await new Promise(resolveWait => setTimeout(resolveWait, 40))
  await agent.cancelTask('cancel')
  assert.equal((await run).at(-1).type, 'cancelled')
  assert.equal((await collect(agent.executeTask({ taskId: 'recovery', input: 'go', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('requires explicit supported profile and rejects local route defaults', async t => {
  const { agent } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'none', input: 'x' }), /model profile is required/)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  const compatible=await collect(agent.executeTask({ taskId: 'provider-label', input: 'go', model: profile({ provider: 'team-proxy', name: 'Display model', baseUrl: undefined }) }))
  assert(compatible.some(e=>e.type==='assistant-complete'))
  assert.throws(() => agent.executeTask({ taskId: 'bad-endpoint', input: 'x', model: profile({ baseUrl: 'https://user:pass@example.com/v1' }) }), /credential-free/)
})

test('nonzero exit, missing terminal success and malformed or oversized NDJSON cannot complete',async t=>{
  const {agent}=await fixture(t)
  for(const input of ['NONZERO','NODONE','MALFORMED','OVERSIZED']) {
    const events=await collect(agent.executeTask({taskId:input,input,model:profile()}))
    assert(events.some(e=>e.type==='error'),input)
    assert(!events.some(e=>e.type==='assistant-complete'),input)
  }
})
