import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackage, createAgentPackageWithRuntime } from '../src/index.mjs'

const fixture = new URL('./fixtures/fake-goose.mjs', import.meta.url)
const profile = { id: 'test-profile', name: 'Test', provider: 'local', model: 'mock-model', protocol: 'openai-chat-completions', apiKeyEnv: 'CUSTOM_CRED', baseUrl: 'http://127.0.0.1:9911/v1' }

async function setup(t, extraEnv = {}) {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-goose-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const argsFile = join(temp, 'args.jsonl')
  const pidFile = join(temp, 'grandchild.pid')
  const env = { CUSTOM_CRED: 'test-key', TALENT_TEST_ARGS_FILE: argsFile, TALENT_TEST_PID_FILE: pidFile, ...extraEnv }
  const packageConfig = { workspace: temp, stateDir: join(temp, 'state'), env, config: { program: process.execPath, cancelGraceMs: 100 } }
  const runtime = {
    command: process.execPath,
    spawnProcess(command, args, options) {
      return spawn(command, [fixture.pathname, ...args], options)
    },
  }
  return { temp, argsFile, pidFile, env, packageConfig, runtime }
}

async function collect(agent, taskId = 'task-1', overrides = {}) {
  const events = []
  for await (const event of agent.executeTask({ taskId, input: 'do a task', sessionId: 'conversation-1', model: profile, ...overrides })) events.push(event)
  return events
}

test('passes the external OpenAI-compatible profile, maps streamed messages/tools, and resumes across instances', async t => {
  const { packageConfig, runtime, argsFile } = await setup(t)
  const first = await createAgentPackageWithRuntime(packageConfig, runtime)
  const events = await collect(first)
  await first.dispose()

  assert(events.some(event => event.type === 'assistant-delta' && event.text === 'hello [redacted]'))
  assert(events.some(event => event.type === 'tool-call' && event.name === 'developer__shell' && event.callId === 'call-1'))
  assert(events.some(event => event.type === 'tool-result' && event.output === 'workspace' && event.status === 'success'))
  assert(events.some(event => event.type === 'assistant-complete'))
  assert(events.some(event => event.type === 'session' && event.sessionId.startsWith('talent-')))
  assert(events.some(event => event.type === 'tool-call' && event.input.command === 'printf [redacted]'))
  assert.equal(JSON.stringify(events).includes('test-key'), false)

  const second = await createAgentPackageWithRuntime(packageConfig, runtime)
  await collect(second, 'task-2')
  await second.dispose()
  const launches = (await readFile(argsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(launches.length, 2)
  assert.equal(launches[0].env.provider, 'openai')
  assert.equal(launches[0].env.model, 'mock-model')
  assert.equal(launches[0].env.host, 'http://127.0.0.1:9911')
  assert.equal(launches[0].env.path, 'v1/chat/completions')
  assert.equal(launches[0].env.key, 'test-key')
  assert.equal(launches[1].args.includes('--resume'), true)
  assert.equal(launches[1].args[launches[1].args.indexOf('--name') + 1], launches[0].args[launches[0].args.indexOf('--name') + 1])
  assert.notEqual(launches[0].env.configDir, process.env.GOOSE_CONFIG_DIR)
})

test('rejects incompatible profiles and missing referenced keys before spawning', async t => {
  const { packageConfig, runtime } = await setup(t)
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'y', model: { ...profile, protocol: 'anthropic-messages' } }), /unsupported model profile protocol/)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'y', model: { ...profile, apiKeyEnv: 'MISSING_KEY' } }), /missing/)
  await agent.dispose()
})

test('redacts Goose error output and reports one error event', async t => {
  const { packageConfig, runtime } = await setup(t, { TALENT_TEST_MODE: 'error' })
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const events = await collect(agent)
  await agent.dispose()
  const errors = events.filter(event => event.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(JSON.stringify(events).includes('test-key'), false)
})

test('cancellation terminates Goose process group and its descendants', async t => {
  const { packageConfig, runtime, pidFile } = await setup(t, { TALENT_TEST_MODE: 'hang' })
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const controller = new AbortController()
  const stream = agent.executeTask({ taskId: 'cancel-me', input: 'wait', sessionId: 'conversation-1', model: profile }, { signal: controller.signal })
  const iterator = stream[Symbol.asyncIterator]()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { await readFile(pidFile, 'utf8'); break } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)) }
  }
  controller.abort()
  const events = []
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
  await agent.dispose()
  assert(events.some(event => event.type === 'cancelled'))
  let pid
  pid = Number(await readFile(pidFile, 'utf8'))
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

test('missing CLI is explicit and never downloads a fallback', async t => {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-goose-missing-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await assert.rejects(
    createAgentPackage({ workspace: temp, stateDir: join(temp, 'state'), env: { CUSTOM_CRED: 'test-key' }, config: { program: join(temp, 'missing-goose-binary') } }),
    /Pinned Goose CLI v1\.48\.0 is not installed.*setup:runtime/,
  )
})

test('an already-aborted signal does not launch Goose', async t => {
  const { packageConfig, runtime, argsFile } = await setup(t)
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const controller = new AbortController()
  controller.abort()
  const events = []
  for await (const event of agent.executeTask({ taskId: 'already-aborted', input: 'do not run', sessionId: 'conversation-1', model: profile }, { signal: controller.signal })) events.push(event)
  await agent.dispose()
  assert(events.some(event => event.type === 'cancelled'))
  await assert.rejects(readFile(argsFile), { code: 'ENOENT' })
})
