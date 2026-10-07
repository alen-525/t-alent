import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { parseCliArgs } from './args.mjs'
import { createLocalClient } from './client.mjs'
import { runCli } from './app.mjs'
import { main } from './index.mjs'
import { makeTerminal } from './terminal.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'talent-cli-'))
  const workspace = path.join(root, 'workspace')
  const packageA = path.join(root, 'package-a')
  const packageB = path.join(root, 'package-b')
  const supported = 'mock-protocol'
  await Promise.all([mkdir(workspace), mkdir(packageA), mkdir(packageB)])
  await Promise.all(['fixture-a', 'fixture-b'].map(id => writeFile(path.join(root, `${id}.events`), '')))
  const source = id => `
    import { appendFile } from 'node:fs/promises'
    export async function createAgentPackage({ stateDir }) {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(stateDir, { recursive: true }))
      let stop
      let stopped = new Promise(resolve => { stop = resolve })
      let active = false
      return {
        async *executeTask({ taskId, input }) {
          active = true
          try {
            if (input === 'hold') {
              yield { type: 'assistant-delta', text: 'working' }
              await stopped
              yield { type: 'cancelled' }
            } else if (input === 'multiple') {
              yield { type: 'assistant-delta', text: 'first segment' }
              yield { type: 'assistant-complete' }
              yield { type: 'assistant-delta', text: 'second segment' }
              yield { type: 'assistant-complete' }
            } else {
              yield { type: 'assistant-delta', text: 'old ' }
              yield { type: 'assistant-replace', text: 'final answer' }
              yield { type: 'assistant-complete' }
            }
          } finally {
            active = false
            await appendFile(${JSON.stringify(path.join(root, `${id}.events`))}, taskId + ':stopped\\n')
          }
        },
        async cancelTask() { stop(); while (active) await new Promise(resolve => setTimeout(resolve, 1)) },
        async dispose() { await appendFile(${JSON.stringify(path.join(root, `${id}.events`))}, 'disposed\\n') },
      }
    }
  `
  for (const [dir, id, protocol] of [[packageA, 'fixture-a', supported], [packageB, 'fixture-b', 'other-protocol']]) {
    const modelProtocols = id === 'fixture-a' ? [protocol] : [supported, protocol]
    await writeFile(path.join(dir, 'agent-package.json'), JSON.stringify({ id, name: id, version: '1', entry: 'index.mjs', modelProtocols }))
    await writeFile(path.join(dir, 'index.mjs'), source(id))
  }
  const modelsPath = path.join(root, 'models.json')
  await writeFile(modelsPath, JSON.stringify({ defaultModelId: 'model-a', models: [
    { id: 'model-a', name: 'Model A', provider: 'mock', model: 'mock-a', protocol: 'mock-protocol', apiKeyEnv: 'MOCK_KEY' },
    { id: 'model-b', name: 'Model B', provider: 'mock', model: 'mock-b', protocol: 'other-protocol', apiKeyEnv: 'MOCK_KEY' },
  ] }))
  return { root, workspace, packageA, packageB, modelsPath, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('CLI parser accepts repeatable package and exec/json options, and rejects missing or unknown options', () => {
  const parsed = parseCliArgs(['exec', '--package', 'one', '--package', 'two', '-', '--json'])
  assert.deepEqual(parsed.packagePaths, ['one', 'two'])
  assert.equal(parsed.exec, true)
  assert.equal(parsed.json, true)
  assert.equal(parsed.prompt, '-')
  assert.throws(() => parseCliArgs(['--package']), /requires|value/i)
  assert.throws(() => parseCliArgs(['--surprise']), /unknown/i)
  assert.throws(() => parseCliArgs(['--json']), /only supported/i)
})

test('local client validates protocol and explicit routing, and does not expose key environment names', async t => {
  const f = await fixture(t)
  const client = await createLocalClient({ packagePaths: [f.packageA], workspace: f.workspace, stateDir: path.join(f.root, 'state'), modelsPath: f.modelsPath, env: { MOCK_KEY: 'secret' } })
  t.after(() => client.close())
  t.after(f.cleanup)
  assert.equal(client.workspace, await realpath(f.workspace))
  assert.equal(client.packages[0].runtimeReady, true)
  assert.equal(client.defaultModelId, 'model-a')
  assert.equal(client.models.some(model => Object.hasOwn(model, 'apiKeyEnv')), false)
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'p', sessionId: 's', packageId: 'missing', modelId: 'model-a', input: 'hello' })) {} }, /package/i)
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'm', sessionId: 's', packageId: 'fixture-a', modelId: 'model-b', input: 'hello' })) {} }, /protocol|support/i)
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'none', sessionId: 's', input: 'hello' })) {} }, /package|model/i)
})

test('session stays bound to its package and model, and package concurrency is limited', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const client = await createLocalClient({ packagePaths: [f.packageA, f.packageB], workspace: f.workspace, stateDir: path.join(f.root, 'state'), modelsPath: f.modelsPath })
  t.after(() => client.close())
  t.after(f.cleanup)
  const task = client.executeTask({ taskId: 'first', sessionId: 'bound', packageId: 'fixture-a', modelId: 'model-a', input: 'hold' })
  const iterator = task[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: { type: 'assistant-delta', text: 'working' }, done: false })
  const drained = (async () => { while (!(await iterator.next()).done) {} })()
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'parallel', sessionId: 'parallel', packageId: 'fixture-a', modelId: 'model-a', input: 'hello' })) {} }, /active|task|running|concurrent/i)
  await client.cancelTask('first')
  await drained
  assert.equal((await iterator.next()).done, true)
  assert.match(await readFile(path.join(f.root, 'fixture-a.events'), 'utf8'), /first:stopped/)
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'other-package', sessionId: 'bound', packageId: 'fixture-b', modelId: 'model-a', input: 'hello' })) {} }, /session|bound/i)
  for await (const _ of client.executeTask({ taskId: 'model-bind', sessionId: 'model-bound', packageId: 'fixture-b', modelId: 'model-a', input: 'hello' })) {}
  await assert.rejects(async () => { for await (const _ of client.executeTask({ taskId: 'other-model', sessionId: 'model-bound', packageId: 'fixture-b', modelId: 'model-b', input: 'hello' })) {} }, /session|bound/i)
})

test('plain output applies replacements once; JSON mode preserves parseable event records', async t => {
  const f = await fixture(t)
  const client = await createLocalClient({ packagePaths: [f.packageA], workspace: f.workspace, stateDir: path.join(f.root, 'state'), modelsPath: f.modelsPath })
  t.after(() => client.close())
  t.after(f.cleanup)
  const collect = () => ({ chunks: [], write(value) { this.chunks.push(String(value)); return true }, get text() { return this.chunks.join('') } })
  const output = collect(); const error = collect()
  assert.equal(await runCli({ client, options: { exec: true, prompt: 'say hi', harness: 'fixture-a', model: 'model-a', stateDir: path.join(f.root, 'state') }, input: '', output, error }), 0)
  assert.equal(output.text.trim(), 'final answer')
  assert.equal(output.text.includes('hello final answer'), false)
  const jsonOut = collect()
  assert.equal(await runCli({ client, options: { exec: true, prompt: 'say hi', json: true, harness: 'fixture-a', model: 'model-a', stateDir: path.join(f.root, 'state') }, input: '', output: jsonOut, error }), 0)
  const rows = jsonOut.text.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.type), ['assistant-delta', 'assistant-replace', 'assistant-complete'])
  assert.equal(error.text, '')

  const multipleOutput = collect()
  assert.equal(await runCli({ client, options: { exec: true, prompt: 'multiple', harness: 'fixture-a', model: 'model-a', stateDir: path.join(f.root, 'state') }, input: '', output: multipleOutput, error }), 0)
  assert.equal(multipleOutput.text, 'first segment\nsecond segment\n')
})

test('TTY exec JSON contains only event lines while plain exec contains only the final reply', { timeout: 5000 }, async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'talent-cli-tty-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const makeStream = () => {
    const stream = new PassThrough()
    stream.isTTY = true
    stream.setRawMode = value => { stream.isRaw = value }
    return stream
  }
  const client = {
    packages: [{ manifest: { id: 'fixture-a', name: 'Fixture', modelProtocols: ['mock-protocol'] }, runtimeReady: true }],
    models: [{ id: 'model-a', protocol: 'mock-protocol', name: 'Model A' }],
    async *executeTask({ input }) {
      yield { type: 'assistant-delta', text: 'draft' }
      if (input === 'fail') {
        yield { type: 'assistant-replace', text: 'partial' }
        yield { type: 'error', message: 'fixture failure' }
      } else {
        yield { type: 'assistant-replace', text: 'final TTY reply' }
        yield { type: 'assistant-complete' }
      }
    },
    async cancelTask() {},
  }
  const input = makeStream(), output = makeStream(), error = makeStream()
  let stdout = '', stderr = ''
  output.on('data', chunk => { stdout += chunk })
  error.on('data', chunk => { stderr += chunk })
  const jsonCode = await runCli({ client, options: { exec: true, prompt: 'fail', json: true, harness: 'fixture-a', model: 'model-a', stateDir }, input, output, error })
  assert.notEqual(jsonCode, 0)
  assert.equal(stderr, '')
  const rows = stdout.trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.type), ['assistant-delta', 'assistant-replace', 'error'])
  assert.equal(stdout.includes('\u001b'), false)

  stdout = ''; stderr = ''
  const plainCode = await runCli({ client, options: { exec: true, prompt: 'success', harness: 'fixture-a', model: 'model-a', stateDir }, input, output, error })
  assert.equal(plainCode, 0)
  assert.equal(stdout, 'final TTY reply\n')
  assert.equal(stderr, '')
  assert.equal(stdout.includes('\u001b'), false)
})

test('terminal multiline input treats Ctrl+J as a newline and restores raw mode', { timeout: 5000 }, async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  const output = new PassThrough()
  output.isTTY = true
  let rendered = ''
  output.on('data', chunk => { rendered += chunk })
  const terminal = makeTerminal({ input, output, color: false })
  const pending = terminal.readLine()
  input.emit('keypress', 'a', { name: 'a' })
  input.emit('keypress', '\n', { name: 'enter' })
  input.emit('keypress', 'b', { name: 'b' })
  input.emit('keypress', '\r', { name: 'return' })
  const result = await pending
  assert.equal(result.value, 'a\nb')
  assert.equal(input.isRaw, false)
  assert.equal(input.readableFlowing, false)
  assert.ok(rendered.length > 0)
})

test('failed tasks return a nonzero exit code and non-TTY without exec exits clearly', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'talent-cli-state-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const output = { chunks: [], write(value) { this.chunks.push(String(value)) } }
  const error = { chunks: [], write(value) { this.chunks.push(String(value)) }, get text() { return this.chunks.join('') } }
  const client = {
    packages: [{ manifest: { id: 'fixture-a', name: 'Fixture', modelProtocols: ['mock-protocol'] }, runtimeReady: true }],
    models: [{ id: 'model-a', protocol: 'mock-protocol', name: 'Model A' }],
    async *executeTask() { yield { type: 'error', message: 'fixture failure' } },
    async cancelTask() {}, async close() {},
  }
  const failed = await runCli({ client, options: { exec: true, prompt: 'work', harness: 'fixture-a', model: 'model-a', stateDir }, input: '', output, error })
  assert.notEqual(failed, 0)
  assert.match(error.text, /fixture failure/)
  output.chunks = []
  const jsonFailure = await runCli({ client, options: { exec: true, prompt: 'work', harness: 'fixture-a', model: 'model-a', json: true, stateDir }, input: '', output, error })
  assert.notEqual(jsonFailure, 0)
  assert.deepEqual(JSON.parse(output.chunks.join('').trim()), { type: 'error', message: 'fixture failure' })
  const nonTty = await runCli({ client, options: { stateDir }, input: { isTTY: false }, output: { isTTY: false, write() {} }, error })
  assert.notEqual(nonTty, 0)
  assert.match(error.text, /tty|--exec|interactive/i)
})

test('startup failure disposes already loaded runtimes', async t => {
  const f = await fixture(t)
  t.after(f.cleanup)
  await assert.rejects(createLocalClient({ packagePaths: [f.packageA, path.join(f.root, 'does-not-exist')], workspace: f.workspace, stateDir: path.join(f.root, 'state'), modelsPath: f.modelsPath }))
  const events = await readFile(path.join(f.root, 'fixture-a.events'), 'utf8')
  assert.match(events, /disposed/)
})

test('exec dash reads stdin and completes without requiring a TTY', async t => {
  const f = await fixture(t)
  const output = { chunks: [], write(value) { this.chunks.push(String(value)) }, get text() { return this.chunks.join('') } }
  const error = { chunks: [], write(value) { this.chunks.push(String(value)) }, get text() { return this.chunks.join('') } }
  t.after(f.cleanup)
  async function* stdin() { yield Buffer.from('read from stdin') }
  const code = await main(['exec', '--package', f.packageA, '--workspace', f.workspace, '--models', f.modelsPath, '--harness', 'fixture-a', '--model', 'model-a', '-'], { input: stdin(), output, error })
  assert.equal(code, 0, error.text)
  assert.equal(output.text.trim(), 'final answer')
})

test('exec requires explicit selection, and saved sessions resume only in their workspace', async t => {
  const f = await fixture(t)
  const other = await fixture(t)
  const stateDir = path.join(f.root, 'state')
  const output = { chunks: [], write(value) { this.chunks.push(String(value)) }, get text() { return this.chunks.join('') } }
  const error = { chunks: [], write(value) { this.chunks.push(String(value)) }, get text() { return this.chunks.join('') } }
  t.after(f.cleanup)
  t.after(other.cleanup)

  const missing = await main(['exec', '--package', f.packageA, '--workspace', f.workspace, '--models', f.modelsPath, '--model', 'model-a', 'do work'], { input: { isTTY: false }, output, error })
  assert.notEqual(missing, 0)
  assert.equal(output.text, '')
  assert.match(error.text, /harness/i)
  error.chunks = []
  const noModel = await main(['exec', '--package', f.packageA, '--workspace', f.workspace, '--harness', 'fixture-a', 'do work'], { input: { isTTY: false }, output, error })
  assert.notEqual(noModel, 0)
  assert.equal(output.text, '')
  assert.match(error.text, /model/i)

  error.chunks = []
  const noDefaultModels = path.join(f.root, 'models-no-default.json')
  const registry = JSON.parse(await readFile(f.modelsPath, 'utf8'))
  delete registry.defaultModelId
  await writeFile(noDefaultModels, JSON.stringify(registry))
  const noDefaultModel = await main(['exec', '--package', f.packageA, '--workspace', f.workspace, '--models', noDefaultModels, '--harness', 'fixture-a', 'do work'], { input: { isTTY: false }, output, error })
  assert.notEqual(noDefaultModel, 0)
  assert.equal(output.text, '')
  assert.match(error.text, /model/i)

  error.chunks = []
  const args = ['exec', '--package', f.packageA, '--workspace', f.workspace, '--models', f.modelsPath, '--state-dir', stateDir, '--harness', 'fixture-a', '--model', 'model-a', 'first task']
  assert.equal(await main(args, { input: { isTTY: false }, output, error }), 0, error.text)
  const saved = JSON.parse(await readFile(path.join(stateDir, 'cli', 'sessions.json'), 'utf8'))
  const sessionId = saved.sessions[0].id
  assert.ok(sessionId)

  assert.equal(await main(['exec', '--package', f.packageA, '--workspace', f.workspace, '--models', f.modelsPath, '--state-dir', stateDir, '--resume', sessionId, 'continue task'], { input: { isTTY: false }, output, error }), 0, error.text)
  const otherCode = await main(['exec', '--package', other.packageA, '--workspace', other.workspace, '--models', other.modelsPath, '--state-dir', stateDir, '--resume', sessionId, 'continue task'], { input: { isTTY: false }, output, error })
  assert.notEqual(otherCode, 0)
  assert.match(error.text, /cannot be resumed|no local session/i)
})
