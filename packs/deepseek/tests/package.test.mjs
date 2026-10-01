import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const fakeDsh = new URL('./fake-dsh.mjs', import.meta.url)

async function fixture(t, runtimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-pack-'))
  const workspace = join(root, 'workspace')
  const stateDir = join(root, 'state')
  const patches = join(root, 'caller.patch.yml')
  await Promise.all([
    import('node:fs/promises').then(({ mkdir }) => mkdir(workspace)),
    writeFile(patches, '[]'),
  ])
  t.after(() => rm(root, { recursive: true, force: true }))
  const agent = await createAgentPackageWithRuntime({
    workspace,
    stateDir,
    env: {
      DEEPSEEK_API_KEY: 'never-event-this-secret',
      PACK_TEST_ARGS_FILE: join(root, 'args.json'),
      PACK_TEST_SIGNAL_FILE: join(root, 'signals.txt'),
    },
    config: { model: 'deepseek-reasoner', reasoningEffort: 'high', maxTokens: 2048, patches: [patches] },
  }, { command: process.execPath, bin: fakeDsh.pathname, spawnProcess: spawn, ...runtimeOptions })
  return { agent, workspace, stateDir, root }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

test('runs the original headless process with host-neutral inputs and maps complete tool/text events', async t => {
  const { agent, workspace, root } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'task-one', input: 'inspect note', sessionId: 'conversation-A' }))
  assert.equal(events.find(event => event.type === 'tool-call').name, 'read_file')
  assert.equal(events.find(event => event.type === 'tool-call').input.path, 'note.txt')
  assert.equal(events.find(event => event.type === 'tool-result').output, 'fixture file contents')
  assert.equal(events.find(event => event.type === 'assistant-delta').text.length, 8192)
  assert.deepEqual(events.slice(-2), [
    { type: 'assistant-replace', text: 'complete answer' },
    { type: 'assistant-complete' },
  ])
  assert.equal(events.some(event => JSON.stringify(event).includes('never-event-this-secret')), false)

  const recorded = JSON.parse(await readFile(join(root, 'args.json'), 'utf8'))
  const { args } = recorded
  assert.deepEqual(args.slice(0, 2), ['--profile', 'headless'])
  assert.equal(args.includes('--json'), true)
  assert.equal(args.at(-1), '-')
  assert.equal(args.includes('--session-id'), false)
  const patch = JSON.parse(recorded.patches[1])
  assert.equal(patch[0].config.provider, 'deepseek-official')
  assert.equal(patch[0].config.model, 'deepseek-reasoner')
  assert.equal(patch[0].config.reasoningEffort, 'high')
  assert.equal(patch[1].config.maxTokens, 2048)
  await agent.dispose()
})

test('reuses the persisted upstream session for consecutive host turns', async t => {
  const { agent, stateDir, root } = await fixture(t)
  const firstEvents = await collect(agent.executeTask({ taskId: 'task-one', input: 'first', sessionId: 'conversation-A' }))
  const upstreamSessionId = firstEvents.find(event => event.type === 'session').sessionId
  await collect(agent.executeTask({ taskId: 'task-two', input: 'second', sessionId: 'conversation-A' }))
  const secondArgs = JSON.parse(await readFile(join(root, 'args.json'), 'utf8')).args
  assert.equal(secondArgs[secondArgs.indexOf('--session-id') + 1], upstreamSessionId)
  assert.equal(JSON.parse(await readFile(join(stateDir, 'deepseek-sessions.json'), 'utf8'))['conversation-A'], upstreamSessionId)
  await agent.dispose()
})

test('reports one failure and never treats a failed final as success', async t => {
  const { agent } = await fixture(t)
  const events = await collect(agent.executeTask({ taskId: 'failure', input: 'FAIL' }))
  assert.deepEqual(events.filter(event => event.type === 'error'), [{ type: 'error', message: 'SERVER: fixture failed [redacted]' }])
  assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  assert.equal(JSON.stringify(events).includes('never-event-this-secret'), false)
  await agent.dispose()
})

test('converts malformed protocol output and redacted boot diagnostics into one error event', async t => {
  const { agent } = await fixture(t)
  const malformed = await collect(agent.executeTask({ taskId: 'malformed', input: 'MALFORMED' }))
  assert.equal(malformed.filter(event => event.type === 'error').length, 1)
  assert.match(malformed.find(event => event.type === 'error').message, /malformed JSON event/)
  const bootFailure = await collect(agent.executeTask({ taskId: 'boot-failure', input: 'NO_JSON_FAIL' }))
  assert.equal(bootFailure.filter(event => event.type === 'error').length, 1)
  assert.equal(JSON.stringify(bootFailure).includes('never-event-this-secret'), false)
  await agent.dispose()
})

test('rejects concurrent tasks, scopes cancel by task id, and discards late output', async t => {
  const { agent } = await fixture(t)
  const stream = agent.executeTask({ taskId: 'long-running', input: 'cancel-case', sessionId: 'conversation-A' })
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value.type, 'session')
  assert.throws(() => agent.executeTask({ taskId: 'overlap', input: 'other' }), /already has active task/)
  await agent.cancelTask('different-task')
  await agent.cancelTask('long-running')
  const rest = []
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event)
  assert.deepEqual(rest, [{ type: 'cancelled' }])
  const next = await collect(agent.executeTask({ taskId: 'after-cancel', input: 'next', sessionId: 'conversation-A' }))
  assert.equal(next.some(event => JSON.stringify(event).includes('late after cancellation')), false)
  await agent.dispose()
})

test('startup cancellation sends one SIGINT and waits for the original child to close', async t => {
  let reachedSpawn
  let releaseSpawn
  let sigintCount = 0
  const spawnBarrier = new Promise(resolve => { reachedSpawn = resolve })
  const spawnRelease = new Promise(resolve => { releaseSpawn = resolve })
  const { agent } = await fixture(t, {
    beforeSpawn: async () => { reachedSpawn(); await spawnRelease },
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options)
      const kill = child.kill.bind(child)
      child.kill = (signal, ...rest) => {
        if (signal === 'SIGINT') sigintCount += 1
        return kill(signal, ...rest)
      }
      return child
    },
  })
  const stream = agent.executeTask({ taskId: 'cancel-during-startup', input: 'cancel-case' })
  const result = collect(stream)
  await spawnBarrier
  const cancelled = agent.cancelTask('cancel-during-startup')
  releaseSpawn()
  await cancelled
  const events = await result
  assert.equal(events.at(-1)?.type, 'cancelled')
  assert.equal(sigintCount, 1)
  const next = await collect(agent.executeTask({ taskId: 'after-startup-cancel', input: 'continue' }))
  assert.equal(next.at(-1)?.type, 'assistant-complete')
  await agent.dispose()
})

test('iterator early return cancels the owned process and disposes cleanly', async t => {
  const { agent } = await fixture(t)
  const iterator = agent.executeTask({ taskId: 'early', input: 'cancel-case' })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return()
  const after = await collect(agent.executeTask({ taskId: 'after-early', input: 'done' }))
  assert.equal(after.some(event => event.type === 'assistant-complete'), true)
  await agent.dispose()
})
