import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackage, createAgentPackageWithRuntime } from '../src/index.mjs'

const fake = new URL('./fixtures/fake-aider.mjs', import.meta.url)
const profile = { id: 'test-profile', provider: 'openai', model: 'mock-model', protocol: 'openai-chat-completions', apiKeyEnv: 'CUSTOM_CRED', baseUrl: 'http://127.0.0.1:9911/v1' }

async function setup(t, extra = {}) {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-aider-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const record = join(temp, 'args.jsonl')
  const pidFile = join(temp, 'descendant.pid')
  await writeFile(join(temp, 'sample.txt'), 'input file content\n')
  const env = { CUSTOM_CRED: 'private-test-key', OPENAI_API_KEY: 'old-key', OPENAI_BASE_URL: 'https://wrong-endpoint/v1', AZURE_OPENAI_ENDPOINT: 'https://azure-wrong-endpoint', AIDER_MODEL: 'evil-model', AIDER_CONFIG: 'evil-config', TALENT_TEST_RECORD: record, TALENT_TEST_PID_FILE: pidFile, ...extra }
  const packageConfig = { workspace: temp, stateDir: join(temp, 'state'), env, config: { cancelGraceMs: 100, files: ['sample.txt'] } }
  const runtime = { command: process.execPath, spawnProcess(command, args, options) { return spawn(command, [fake.pathname, ...args], options) } }
  return { temp, record, pidFile, env, packageConfig, runtime }
}
async function collect(agent, taskId = 'task-1', model = profile, overrides = {}) {
  const result = []
  for await (const event of agent.executeTask({ taskId, input: 'inspect sample.txt and append proof', sessionId: 'conversation-1', model, ...overrides })) result.push(event)
  return result
}

test('uses Aider single-task loop flags, exact external route, isolated env, and resumes history across instances', async t => {
  const { packageConfig, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const firstEvents = await collect(agent)
  await agent.dispose()
  const second = await createAgentPackageWithRuntime(packageConfig, runtime)
  await collect(second, 'task-2')
  await second.dispose()
  assert(firstEvents.some(event => event.type === 'assistant-replace' && event.text.includes('Aider completed')))
  assert(firstEvents.at(-1).type === 'assistant-complete')
  const launches = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(launches.length, 2)
  for (const args of launches.map(launch => launch.args)) {
    assert(args.includes('--message-file'))
    assert(args.includes('--no-auto-commits'))
    assert(args.includes('--no-dirty-commits'))
    assert(args.includes('--yes-always'))
    assert(args.includes('--no-stream'))
    assert(args.includes('--no-show-release-notes'))
    assert(args.includes('--no-check-update'))
    assert(args.includes('--no-browser'))
    assert(args.includes('--disable-playwright'))
    assert(args.includes('sample.txt'))
    assert(args.includes('--restore-chat-history') === (args === launches[1].args))
    assert.equal(args.includes('private-test-key'), false)
    assert.equal(args.some(arg => arg.includes('private-test-key')), false)
  }
  assert.equal(launches[0].args[launches[0].args.indexOf('--model') + 1], 'openai/mock-model')
  assert.equal(launches[0].env.apiKey, 'private-test-key')
  assert.equal(launches[0].env.apiBase, 'http://127.0.0.1:9911/v1')
  assert.equal(launches[0].env.oldEndpoint, undefined)
  assert.equal(launches[0].env.oldAzureEndpoint, undefined)
  assert.equal(launches[0].env.oldAiderModel, undefined)
  assert.equal(launches[0].env.browser, '/usr/bin/true')
  assert.notEqual(launches[0].env.home, process.env.HOME)
  assert.equal(JSON.stringify(firstEvents).includes('private-test-key'), false)
})

test('isolates saved history by complete profile fingerprint', async t => {
  const { packageConfig, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  await collect(agent)
  await collect(agent, 'task-2', { ...profile, model: 'other-model' })
  await agent.dispose()
  const launches = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.notEqual(launches[0].args[launches[0].args.indexOf('--chat-history-file') + 1], launches[1].args[launches[1].args.indexOf('--chat-history-file') + 1])
  assert.equal(launches[1].args.includes('--restore-chat-history'), false)
})

test('rejects incompatible routes, legacy config and missing profile key before launch', async t => {
  const { packageConfig, runtime } = await setup(t)
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'y', model: { ...profile, protocol: 'anthropic' } }), /unsupported model profile protocol/)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'y', model: { ...profile, provider: 'openrouter' } }), /provider must be openai/)
  await assert.rejects(createAgentPackageWithRuntime({ ...packageConfig, config: { model: 'rogue-model' } }, runtime), /must come from the external model profile/)
  assert.throws(() => agent.executeTask({ taskId: 'x', input: 'y', model: { ...profile, apiKeyEnv: 'MISSING_KEY' } }), /missing/)
  await agent.dispose()
})

test('file selection rejects traversal and symlink escape before launching Aider', async t => {
  const { packageConfig, runtime, temp, record } = await setup(t)
  const outside = join(temp, 'outside.txt')
  await writeFile(outside, 'secret\n')
  const symlink = join(temp, 'link.txt')
  await import('node:fs/promises').then(fs => fs.symlink(outside, symlink))
  for (const files of [['../outside.txt'], ['link.txt']]) {
    const agent = await createAgentPackageWithRuntime({ ...packageConfig, config: { files } }, runtime)
    const events = await collect(agent)
    await agent.dispose()
    assert(events.some(event => event.type === 'error' && /stay inside|non-symlink/.test(event.message)))
  }
  await assert.rejects(readFile(record), { code: 'ENOENT' })
})

test('redacts failure output and does not emit completion after nonzero exit', async t => {
  const { packageConfig, runtime } = await setup(t, { TALENT_TEST_MODE: 'error' })
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const events = await collect(agent)
  await agent.dispose()
  assert(events.some(event => event.type === 'error' && event.message.includes('[redacted]')))
  assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  assert.equal(JSON.stringify(events).includes('private-test-key'), false)
})

test('cancellation kills the complete subprocess group and emits cancelled', async t => {
  const { packageConfig, runtime, pidFile } = await setup(t, { TALENT_TEST_MODE: 'hang' })
  const agent = await createAgentPackageWithRuntime(packageConfig, runtime)
  const controller = new AbortController()
  const iterator = agent.executeTask({ taskId: 'cancel', input: 'hang', sessionId: 'conversation-1', model: profile }, { signal: controller.signal })[Symbol.asyncIterator]()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { try { await readFile(pidFile, 'utf8'); break } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)) } }
  controller.abort()
  const events = []
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
  await agent.dispose()
  assert(events.some(event => event.type === 'cancelled'))
  const pid = Number(await readFile(pidFile, 'utf8'))
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

test('normal factory verifies the pinned executable version', async t => {
  const { temp } = await setup(t)
  await assert.rejects(createAgentPackage({ workspace: temp, stateDir: join(temp, 'state'), config: { program: process.execPath } }), /must report version 0\.86\.2/)
})
