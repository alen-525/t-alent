import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile = { id: 'profile-a', provider: 'openai', model: 'mock-model', protocol: 'openai-chat-completions', apiKeyEnv: 'CUSTOM_CRED', baseUrl: 'http://127.0.0.1:9999/v1' }
const fixture = new URL('./fixtures/fake-worker.mjs', import.meta.url)
async function setup(t, mode) {
  const temp = await mkdtemp(join(os.tmpdir(), 'talent-deepagents-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const record = join(temp, 'record.jsonl')
  const pidFile = join(temp, 'descendant.pid')
  const env = { CUSTOM_CRED: 'test-private-key', OPENAI_API_BASE: 'http://wrong-host/v1', LANGSMITH_API_KEY: 'wrong-secret', TALENT_TEST_RECORD: record, TALENT_TEST_PID_FILE: pidFile, ...(mode ? { TALENT_TEST_MODE: mode } : {}) }
  const options = { workspace: temp, stateDir: join(temp, 'state'), env, config: { cancelGraceMs: 100 } }
  const runtime = { command: process.execPath, worker: fixture.pathname, spawnProcess(command, args, spawnOptions) { return spawn(command, args, spawnOptions) } }
  return { temp, record, pidFile, env, options, runtime }
}
async function collect(agent, taskId='one', model=profile, sessionId='conversation') {
  const events=[]
  for await (const event of agent.executeTask({ taskId, sessionId, model, input: 'Read sample.txt and append a proof line.' })) events.push(event)
  return events
}

test('streams worker tools and assistant output; accepts provider labels and resumes across adapter instances', async t => {
  const { options, runtime, record } = await setup(t)
  const customProvider = { ...profile, provider: 'local-compatible' }
  const first = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(first, 'one', customProvider)
  await first.dispose()
  const second = await createAgentPackageWithRuntime(options, runtime)
  await collect(second, 'two', customProvider)
  await second.dispose()
  assert(events.some(e => e.type === 'tool-call' && e.name === 'read_file'))
  assert(events.some(e => e.type === 'tool-result' && e.output === 'alpha [redacted]'))
  assert(events.some(e => e.type === 'assistant-delta' && e.text === 'Edited file.'))
  assert(events.at(-1).type === 'assistant-complete')
  assert.equal(JSON.stringify(events).includes('test-private-key'), false)
  const launches = (await readFile(record, 'utf8')).trim().split('\n').map(x=>JSON.parse(x))
  assert.equal(launches.length, 2)
  assert.equal(launches[0].payload.threadId, launches[1].payload.threadId)
  assert.equal(launches[0].payload.dbPath, launches[1].payload.dbPath)
  assert.equal(launches[0].payload.model, 'mock-model')
  assert.equal(launches[0].env.key, 'test-private-key')
  assert.equal(launches[0].env.endpoint, 'http://127.0.0.1:9999/v1')
  assert.equal(launches[0].env.inherited, undefined)
  assert.equal(launches[0].env.browser, '/usr/bin/true')
  assert.notEqual(launches[0].payload.threadId, 'conversation')
})

test('model profile fingerprint creates separate checkpoint database and thread', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  await collect(agent)
  await collect(agent, 'other', { ...profile, model: 'different-model' })
  await agent.dispose()
  const launches = (await readFile(record, 'utf8')).trim().split('\n').map(x=>JSON.parse(x))
  assert.notEqual(launches[0].payload.dbPath, launches[1].payload.dbPath)
  assert.notEqual(launches[0].payload.threadId, launches[1].payload.threadId)
})

test('rejects unsupported route and missing selected credentials before worker launch', async t => {
  const { options, runtime } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  assert.throws(()=>agent.executeTask({ taskId:'x',input:'y',model:{...profile,protocol:'anthropic'} }),/supports only/)
  assert.throws(()=>agent.executeTask({ taskId:'x',input:'y',model:{...profile,apiKeyEnv:'MISSING_KEY'} }),/missing/)
  await agent.dispose()
})

test('worker 401 failure is redacted and never completes', async t => {
  const { options, runtime } = await setup(t, 'error')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent)
  await agent.dispose()
  assert(events.some(e=>e.type==='error'&&e.message.includes('[redacted]')))
  assert.equal(events.some(e=>e.type==='assistant-complete'),false)
  assert.equal(JSON.stringify(events).includes('test-private-key'),false)
})

test('redacts every emitted string field recursively', async t => {
  const { options, runtime } = await setup(t, 'leak')
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const events = await collect(agent)
  await agent.dispose()
  assert.equal(JSON.stringify(events).includes('test-private-key'), false)
  assert(events.some(e=>e.type==='assistant-delta'&&e.text==='[redacted]'))
})

test('rejects unknown worker events and never completes when a completed worker exits nonzero', async t => {
  for (const mode of ['malformed', 'complete-fail']) {
    const { options, runtime } = await setup(t, mode)
    const agent = await createAgentPackageWithRuntime(options, runtime)
    const events = await collect(agent)
    await agent.dispose()
    assert(events.some(e=>e.type==='error'))
    assert.equal(events.some(e=>e.type==='assistant-complete'), false)
  }
})

test('cancellation kills worker process group and emits cancelled', async t => {
  const { options, runtime, pidFile } = await setup(t,'hang')
  const agent = await createAgentPackageWithRuntime(options,runtime)
  const controller = new AbortController()
  const iterator = agent.executeTask({taskId:'cancel',sessionId:'cancel-session',input:'wait',model:profile},{signal:controller.signal})[Symbol.asyncIterator]()
  const deadline=Date.now()+5000
  while(Date.now()<deadline){try{await readFile(pidFile,'utf8');break}catch{await new Promise(r=>setTimeout(r,20))}}
  controller.abort()
  const events=[]
  for await(const event of {[Symbol.asyncIterator]:()=>iterator})events.push(event)
  await agent.dispose()
  assert(events.some(e=>e.type==='cancelled'))
  const pid=Number(await readFile(pidFile,'utf8'))
  await new Promise(r=>setTimeout(r,100))
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH')
})

test('already-aborted task never launches the worker', async t => {
  const { options, runtime, record } = await setup(t)
  const agent = await createAgentPackageWithRuntime(options, runtime)
  const controller = new AbortController()
  controller.abort()
  const events=[]
  for await (const event of agent.executeTask({taskId:'aborted',input:'do not run',model:profile},{signal:controller.signal})) events.push(event)
  await agent.dispose()
  assert(events.some(e=>e.type==='cancelled'))
  await assert.rejects(readFile(record),{code:'ENOENT'})
})
