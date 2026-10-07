import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { compileAgentPackage } from './agent-compiler.mjs'
import { createProgramRuntime } from './agent-program.mjs'
import { loadPackage, readPackageManifest } from './host.mjs'
import { validateManifest as browserManifest } from '../../apps/web/src/runtime-contract.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'talent-program-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pack = path.join(root, 'pack')
  await mkdir(path.join(pack, 'prompts'), { recursive: true })
  const definition = {
    schemaVersion: 1, id: 'custom-coder', name: 'Custom coder', version: '0.2.0',
    source: { agent: 'codex', version: '0.159.3' }, modelProtocols: ['openai-responses'],
    prompts: { system: 'system.md', special: 'special.md', task: 'task.md' },
    logic: { adapter: 'codex', defaults: {}, steps: [
      { type: 'prompt', ref: 'system' },
      { type: 'prompt', ref: 'special', when: { provider: 'test-vendor', model: 'model-a' } },
      { type: 'prompt', ref: 'task' }, { type: 'execute' },
    ] },
  }
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify(definition))
  await writeFile(path.join(pack, 'prompts/system.md'), 'Work in {{workspace}} using {{source.agent}} {{source.version}}.')
  await writeFile(path.join(pack, 'prompts/special.md'), 'Apply the selected model-specific policy.')
  await writeFile(path.join(pack, 'prompts/task.md'), '{{model.id}}: {{input}}')
  return { root, pack, definition }
}

const model = { id: 'external-model', provider: 'test-vendor', model: 'model-a', protocol: 'openai-responses', apiKeyEnv: 'PRIVATE_API_KEY' }

test('compiled programs drive native tasks, adapt current profiles, preserve events and cancellation', async t => {
  const { pack, root } = await fixture(t)
  const compiled = await compileAgentPackage(pack, { cache: false })
  const calls = [], cancellations = []
  let disposed = 0
  const native = {
    executeTask(task, options) {
      calls.push({ task, options })
      return (async function* () { yield { type: 'assistant-delta', text: 'native answer' }; yield { type: 'assistant-complete' } })()
    },
    async cancelTask(id) { cancellations.push(id) },
    async dispose() { disposed++ },
  }
  const runtime = createProgramRuntime({ ...compiled, runtime: native, workspace: root })
  const abort = new AbortController()
  const options = { signal: abort.signal }
  const events = []
  for await (const event of runtime.executeTask({ taskId: 'one', sessionId: 'conversation', input: 'Keep {{model.id}} as user text.', model }, options)) events.push(event)
  assert.deepEqual(events, [{ type: 'assistant-delta', text: 'native answer' }, { type: 'assistant-complete' }])
  assert.match(calls[0].task.input, /model-specific policy/)
  assert.match(calls[0].task.input, /external-model: Keep \{\{model.id\}\} as user text\./)
  assert.doesNotMatch(calls[0].task.input, /PRIVATE_API_KEY/)
  assert.strictEqual(calls[0].task.model, model)
  assert.strictEqual(calls[0].options, options)
  assert.notEqual(calls[0].task.sessionId, 'conversation')
  for await (const _ of runtime.executeTask({ taskId: 'two', sessionId: 'conversation', input: 'Second request.', model: { ...model, model: 'model-b' } })) {}
  assert.doesNotMatch(calls[1].task.input, /model-specific policy/)
  assert.equal(calls[1].task.sessionId, calls[0].task.sessionId)
  assert.throws(() => runtime.executeTask({ input: 'hello' }), /model profile/i)
  assert.throws(() => runtime.executeTask({ input: 'hello', model: { ...model, protocol: 'unsupported' } }), /protocol/i)
  assert.equal(calls.length, 2)
  await runtime.cancelTask('one')
  assert.deepEqual(cancellations, ['one'])
  await runtime.dispose(); await runtime.dispose()
  assert.equal(disposed, 1)
  assert.throws(() => runtime.executeTask({ input: 'hello', model }), /disposed/i)
})

test('changed recipes isolate upstream histories and public metadata excludes processing logic', async t => {
  const { pack, root } = await fixture(t)
  const first = await compileAgentPackage(pack, { cache: false })
  const ids = []
  const native = { executeTask(task) { ids.push(task.sessionId); return [] }, async cancelTask() {}, async dispose() {} }
  const run = compiled => createProgramRuntime({ ...compiled, runtime: native, workspace: root }).executeTask({ taskId: 'one', sessionId: 'same', input: 'hello', model })
  run(first)
  await writeFile(path.join(pack, 'prompts/system.md'), 'Changed instructions for {{workspace}}.')
  const changed = await compileAgentPackage(pack, { cache: false })
  run(changed)
  assert.notEqual(ids[0], ids[1])
  const metadata = await readPackageManifest(pack)
  assert.deepEqual(browserManifest(metadata), metadata)
  assert.deepEqual(metadata.source, { agent: 'codex', version: '0.159.3' })
  assert.equal(metadata.version, '0.2.0')
  assert.equal(Object.hasOwn(metadata, 'prompts'), false)
  assert.equal(Object.hasOwn(metadata, 'logic'), false)
})

test('loader rejects unknown adapters, unsupported protocols and mismatched source versions before activation', async t => {
  const { pack, root, definition } = await fixture(t)
  for (const [overrides, pattern] of [
    [{ logic: { ...definition.logic, adapter: 'constructor' } }, /Unknown framework adapter/],
    [{ source: { agent: 'codex', version: '9.9.9' } }, /source version/],
    [{ modelProtocols: ['anthropic'] }, /unsupported by adapter/],
  ]) {
    await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify({ ...definition, ...overrides }))
    await assert.rejects(loadPackage(pack, { workspace: root, stateRoot: path.join(root, 'state'), env: {} }), pattern)
  }
})
