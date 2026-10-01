import test from 'node:test'
import assert from 'node:assert/strict'
import { appendTaskEvent, isRunnable, registeredRecord, validateManifest } from './runtime-contract.js'

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
})

test('manifest parser rejects unsafe or incomplete package metadata', () => {
  assert.throws(() => validateManifest({ ...manifest, id: '../escape' }), /id must/)
  assert.throws(() => validateManifest({ ...manifest, name: ' ' }), /name must/)
  assert.throws(() => validateManifest('{"id":"x"}'), /JSON object/)
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
