import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runCli } from './app.mjs'

test('saved CLI sessions bind package/source versions and compiled instructions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'talent-version-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pkg = {
    manifest: { id: 'codex', name: 'Codex', version: '0.2.0', source: { agent: 'codex', version: '0.159.3' }, modelProtocols: ['openai-responses'] },
    runtimeReady: true, compilation: { fingerprint: 'original-program' },
  }
  let executions = 0
  const client = {
    workspace: root, packages: [pkg], models: [{ id: 'model', provider: 'test', model: 'test', protocol: 'openai-responses' }],
    async *executeTask() { executions++; yield { type: 'assistant-delta', text: 'answer' }; yield { type: 'assistant-complete' } },
    async cancelTask() {},
  }
  const output = { write() {} }, error = { text: '', write(value) { this.text += value } }
  const run = options => runCli({ client, input: {}, output, error, options: { exec: true, prompt: 'task', stateDir: root, ...options } })
  assert.equal(await run({ harness: 'codex', model: 'model' }), 0)
  const { sessions } = JSON.parse(await readFile(path.join(root, 'cli/sessions.json'), 'utf8'))
  const session = sessions[0]
  assert.equal(session.packageVersion, '0.2.0')
  assert.equal(session.sourceVersion, '0.159.3')
  assert.equal(session.programFingerprint, 'original-program')
  for (const [object, key, value] of [
    [pkg.manifest, 'version', '0.3.0'],
    [pkg.manifest.source, 'version', '0.160.0'],
    [pkg.compilation, 'fingerprint', 'changed-program'],
  ]) {
    const original = object[key]
    object[key] = value
    assert.equal(await run({ resume: session.id }), 1)
    object[key] = original
  }
  assert.equal(executions, 1)
  assert.match(error.text, /harness version, compiled program/)
  assert.equal(await run({ resume: session.id }), 0)
  assert.equal(executions, 2)
})
