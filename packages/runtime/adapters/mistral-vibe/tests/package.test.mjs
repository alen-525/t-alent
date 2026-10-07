import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = overrides => ({ id: 'host-profile', provider: 'external', model: 'model-1', protocol: 'openai-chat-completions', apiKeyEnv: 'HOST_KEY', baseUrl: 'http://127.0.0.1:5055/v1', ...overrides })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'talent-mistral-vibe-'))
  const agent = await createAgentPackageWithRuntime({ workspace: dir, stateDir: join(dir, 'state'), env: { HOST_KEY: 'host-secret-value' }, config: { cancelGraceMs: 120 } }, { command: process.execPath, args: [new URL('./fake-vibe.mjs', import.meta.url).pathname], spawnProcess: spawn })
  t.after(async () => { await agent.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { agent, dir }
}
async function collect(iterable) { const output = []; for await (const event of iterable) output.push(event); return output }

test('maps ACP tool and assistant events, persisting sessions by host session and model route', async t => {
  const { agent } = await fixture(t)
  const model = profile()
  const first = await collect(agent.executeTask({ taskId: 'first', sessionId: 'host-A', input: 'do work', model }))
  assert.equal(first[0].type, 'session')
  assert(first.some(event => event.type === 'tool-call' && event.name === 'terminal'))
  assert(first.some(event => event.type === 'tool-result' && event.output === 'native proof'))
  assert.equal(first.at(-1).type, 'assistant-complete')
  const second = await collect(agent.executeTask({ taskId: 'second', sessionId: 'host-A', input: 'again', model: profile({ name: 'display label' }) }))
  assert.equal(second.find(event => event.type === 'session').sessionId, first.find(event => event.type === 'session').sessionId)
  const isolated = await collect(agent.executeTask({ taskId: 'isolated', sessionId: 'host-A', input: 'again', model: profile({ model: 'model-2' }) }))
  assert.notEqual(isolated.find(event => event.type === 'session').sessionId, first.find(event => event.type === 'session').sessionId)
})

test('rejects profiles without host credentials and reports ACP authentication failures safely', async t => {
  const { agent } = await fixture(t)
  assert.throws(() => agent.executeTask({ taskId: 'bad', input: 'x', model: profile({ protocol: 'anthropic' }) }), /unsupported model profile protocol/)
  const events = await collect(agent.executeTask({ taskId: 'auth', input: 'provider error', model: profile() }))
  assert.equal(events.at(-1).type, 'error')
  assert.equal(JSON.stringify(events).includes('host-secret-value'), false)
})

test('cancels the ACP task and keeps the saved native session recoverable', async t => {
  const { agent } = await fixture(t)
  const stream = agent.executeTask({ taskId: 'cancel', sessionId: 'host-cancel', input: 'hang', model: profile() })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value.type, 'session')
  await stream.return()
  const events = await collect(agent.executeTask({ taskId: 'recover', sessionId: 'host-cancel', input: 'continue', model: profile() }))
  assert.equal(events.at(-1).type, 'assistant-complete')
})

test('reports recoverable tool failure without changing the native turn outcome', async t => {
  const { agent } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'tool failed', input: 'tool failed', model: profile() }))
  assert(events.some(event => event.type === 'tool-result' && event.status === 'error'))
  assert.equal(events.at(-1).type, 'assistant-complete')
})

test('rejects malformed or oversized ACP lines and recovers for another turn', async t => {
  const { agent } = await fixture(t)
  for (const input of ['malformed', 'oversized']) {
    const events = await collect(agent.executeTask({ taskId: input, input, model: profile() }))
    assert.equal(events.at(-1).type, 'error', `${input}: ${JSON.stringify(events.slice(-2))}`)
    assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  }
  assert.equal((await collect(agent.executeTask({ taskId: 'recover', input: 'work', model: profile() }))).at(-1).type, 'assistant-complete')
})

test('keeps distinct host profiles and workspaces in separate native sessions', async t => {
  const { agent, dir } = await fixture(t)
  const first = await collect(agent.executeTask({ taskId: 'one', sessionId: 'same', input: 'work', model: profile() }))
  const separate = await collect(agent.executeTask({ taskId: 'two', sessionId: 'same', input: 'work', model: profile({ id: 'another-profile' }) }))
  assert.notEqual(first[0].sessionId, separate[0].sessionId)
  const workspace = join(dir, 'other-workspace')
  await mkdir(workspace)
  const other = await createAgentPackageWithRuntime({ workspace, stateDir: join(dir, 'state'), env: { HOST_KEY: 'host-secret-value' }, config: { cancelGraceMs: 120 } }, { command: process.execPath, args: [new URL('./fake-vibe.mjs', import.meta.url).pathname], spawnProcess: spawn })
  t.after(() => other.dispose())
  const events = await collect(other.executeTask({ taskId: 'three', sessionId: 'same', input: 'work', model: profile() }))
  assert.notEqual(first[0].sessionId, events[0].sessionId)
  const sessions = JSON.parse(await readFile(join(dir, 'state/sessions.json'), 'utf8'))
  assert.equal(Object.keys(sessions).length, 3)
})

test('rejects a corrupted session store instead of silently losing history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'talent-vibe-corrupt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'sessions.json'), '{broken')
  await assert.rejects(createAgentPackageWithRuntime({ workspace: dir, stateDir: dir }, { command: process.execPath, spawnProcess: spawn }), /JSON/)
})
