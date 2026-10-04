import test from 'node:test'
import assert from 'node:assert/strict'
import { appendTaskEvent, isRunnable, registeredRecord, supportsModel, validateManifest, validateModelCatalog } from './runtime-contract.js'

const manifest = { id: 'acme.agent', name: 'Acme Agent', version: '1.0.0' }

test('no installed package and no host cannot run a task', () => {
  assert.equal(isRunnable([], '', undefined), false)
})

test('validating and registering a descriptor never marks it runtime ready', () => {
  const registered = registeredRecord(validateManifest(manifest))
  assert.equal(registered.runtimeReady, false)
  assert.equal(isRunnable([registered], manifest.id, {}), false)
})

test('execution needs an explicit selected runtime-ready package and a connected host', () => {
  const rows = [{ manifest, runtimeReady: true }]
  assert.equal(isRunnable(rows, '', {}), false)
  assert.equal(isRunnable(rows, 'other.agent', {}), false)
  assert.equal(isRunnable(rows, manifest.id, undefined), false)
  assert.equal(isRunnable(rows, manifest.id, {}), true)
  assert.equal(isRunnable(rows, manifest.id, { connected: false }), false)
})

test('manifest parser rejects unsafe or incomplete package metadata', () => {
  assert.throws(() => validateManifest({ ...manifest, id: '../escape' }), /id must/)
  assert.throws(() => validateManifest({ ...manifest, name: ' ' }), /name must/)
  assert.throws(() => validateManifest('{"id":"x"}'), /JSON object/)
})

test('manifest model protocol capabilities are preserved and drive compatibility', () => {
  const capable = validateManifest({ ...manifest, modelProtocols: ['responses', 'chat-completions'] })
  assert.deepEqual(capable.modelProtocols, ['responses', 'chat-completions'])
  assert.equal(supportsModel(capable, { protocol: 'responses' }), true)
  assert.equal(supportsModel(capable, { protocol: 'legacy' }), false)
  assert.equal(supportsModel(validateManifest(manifest), { protocol: 'legacy' }), true)
  assert.throws(() => validateManifest({ ...manifest, modelProtocols: [''] }), /modelProtocols/)
})

test('model catalog accepts only safe public profiles and an explicit external default', () => {
  assert.deepEqual(validateModelCatalog({ models: [{ id: 'gateway/openai/gpt-x', name: 'Fast', provider: 'gateway', model: 'gpt-x', protocol: 'responses' }], defaultModelId: 'gateway/openai/gpt-x' }), {
    models: [{ id: 'gateway/openai/gpt-x', name: 'Fast', provider: 'gateway', model: 'gpt-x', protocol: 'responses' }],
    defaultModelId: 'gateway/openai/gpt-x',
  })
  assert.throws(() => validateModelCatalog({ models: {} }), /invalid model catalog/)
  assert.throws(() => validateModelCatalog({ models: [{ id: 'leak', provider: 'p', model: 'm', protocol: 'x', apiKeyEnv: 'SECRET' }] }), /invalid model profile/)
  assert.throws(() => validateModelCatalog({ models: [{ id: '', provider: 'p', model: 'm', protocol: 'x' }] }), /invalid model profile/)
})

test('task events build assistant text from deltas and keep tool activity visible', () => {
  let turns = []
  turns = appendTaskEvent(turns, { type: 'assistant-delta', text: 'Hello' })
  turns = appendTaskEvent(turns, { type: 'assistant-delta', text: ' world' })
  turns = appendTaskEvent(turns, { type: 'tool-call', name: 'lookup', input: { q: 1 } })
  turns = appendTaskEvent(turns, { type: 'tool-result', name: 'lookup', output: 'ok' })
  turns = appendTaskEvent(turns, { type: 'cancelled' })
  assert.deepEqual(turns, [
    { role: 'assistant', text: 'Hello world' },
    { role: 'tool', text: 'lookup · {"q":1}' },
    { role: 'tool', text: 'lookup · "ok"' },
    { role: 'tool', text: 'Task cancelled' },
  ])
})

test('assistant replacement corrects a truncated streaming answer without discarding earlier turns', () => {
  const turns = [
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'truncated head' },
    { role: 'tool', text: 'tool detail' },
  ]
  assert.deepEqual(appendTaskEvent(turns, { type: 'assistant-replace', text: 'complete answer' }), [
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'complete answer' },
    { role: 'tool', text: 'tool detail' },
  ])
  assert.deepEqual(appendTaskEvent([], { type: 'assistant-replace', text: 'complete answer' }), [{ role: 'assistant', text: 'complete answer' }])
})
