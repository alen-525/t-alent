import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearMemoryCache, compileAgentPackage, renderProgram, validateAgentManifest } from './agent-compiler.mjs'

const manifestBase = () => ({
  schemaVersion: 1,
  id: 'fixture.agent',
  name: 'Fixture Agent',
  version: '0.2.0',
  modelProtocols: ['test-protocol'],
  source: { agent: 'fixture-source', version: '1.4.0' },
  prompts: { system: 'system.md', task: 'task.md', protocol: 'protocol.md' },
  logic: {
    adapter: 'test-adapter',
    defaults: { temperature: 0.2, nested: { enabled: true } },
    steps: [
      { type: 'prompt', ref: 'system' },
      { type: 'prompt', ref: 'task' },
      { type: 'prompt', ref: 'protocol', when: { protocol: 'test-protocol', provider: 'fixture' } },
      { type: 'execute' },
    ],
  },
})

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value) { return createHash('sha256').update(value).digest('hex') }

async function fixture(t, { task = 'Input={{input}} at {{workspace}} for {{package.id}}/{{package.version}} via {{model.provider}} {{model.id}}/{{model.model}}/{{model.protocol}} from {{source.agent}} {{source.version}}', extraRoot = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'talent-agent-compiler-'))
  const pack = path.join(root, 'pack')
  const prompts = path.join(pack, 'prompts')
  await mkdir(prompts, { recursive: true })
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify(manifestBase(), null, 2))
  await writeFile(path.join(prompts, 'system.md'), 'System rules.')
  await writeFile(path.join(prompts, 'task.md'), task)
  await writeFile(path.join(prompts, 'protocol.md'), 'Protocol-specific instructions.')
  if (extraRoot) await writeFile(path.join(pack, 'README.md'), 'not allowed')
  t.after(async () => { clearMemoryCache(); await rm(root, { recursive: true, force: true }) })
  return { root, pack, prompts }
}

test('schema-v1 is strict, versioned, and rejects unsafe model routing defaults', () => {
  const valid = validateAgentManifest(manifestBase())
  assert.equal(valid.schemaVersion, 1)
  assert.equal(valid.version, '0.2.0')
  for (const mutate of [
    value => { value.extra = true },
    value => { value.entry = 'index.mjs' },
    value => { value.schemaVersion = 2 },
    value => { value.version = '^0.2.0' },
    value => { value.source.version = '>=1.0' },
    value => { value.logic.defaults.apiKeyEnv = 'TOKEN' },
    value => { value.logic.steps.push({ type: 'prompt', ref: 'task', when: { protocol: 'x' } }) },
    value => { value.logic.steps[1].when = { protocol: 'x' } },
    value => { value.logic.steps.pop() },
  ]) {
    const candidate = structuredClone(manifestBase())
    mutate(candidate)
    assert.throws(() => validateAgentManifest(candidate), /Invalid agent package/)
  }
})

test('compiler emits safe JSON AST, routes exact conditions, and preserves task input', async t => {
  const { pack } = await fixture(t)
  const compiled = await compileAgentPackage(pack)
  assert.equal(compiled.manifest.id, 'fixture.agent')
  assert.equal(compiled.program.manifest.modelProtocols[0], 'test-protocol')
  assert.deepEqual(compiled.program.protocolLookup, { 'test-protocol': 'test-adapter' })
  assert.equal(compiled.program.steps.at(-1).type, 'execute')
  assert.doesNotMatch(JSON.stringify(compiled.program), /eval\(|function\s*\(/)
  const matching = renderProgram(compiled.program, {
    input: 'hello {{model.id}}', workspace: '/work',
    model: { id: 'profile', provider: 'fixture', model: 'remote-model', protocol: 'test-protocol' },
  })
  assert.match(matching, /System rules\.\n\nInput=hello \{\{model\.id\}\} at \/work/)
  assert.match(matching, /Protocol-specific instructions\./)
  assert.match(matching, /fixture-source 1\.4\.0/)
  assert.doesNotMatch(renderProgram(compiled.program, { input: 'x', workspace: '/', model: { id: 'm', provider: 'other', model: 'n', protocol: 'test-protocol' } }), /Protocol-specific/)
  assert.equal(compiled.program.prompts.task[1].name, 'input')
})

test('unknown and malformed prompt expressions fail without evaluation', async t => {
  for (const text of ['{{process.exit}}', '{{ model.id}}', '{{input', 'stray }}', '{{input {{workspace}}}}']) {
    const { pack } = await fixture(t, { task: text })
    await assert.rejects(compileAgentPackage(pack), /Invalid agent package/)
  }
})

test('root and prompts tree allow only declared package files', async t => {
  const { pack } = await fixture(t, { extraRoot: true })
  await assert.rejects(compileAgentPackage(pack), /only agent-package\.json and prompts/)
  const clean = await fixture(t)
  await writeFile(path.join(clean.prompts, 'extra.md'), 'not referenced')
  await assert.rejects(compileAgentPackage(clean.pack), /exactly the files declared/)
})

test('prompt symlinks may not escape the prompts directory', async t => {
  const { root, pack, prompts } = await fixture(t)
  await rm(path.join(prompts, 'protocol.md'))
  const outside = path.join(root, 'outside.md')
  await writeFile(outside, 'external prompt')
  await symlink(outside, path.join(prompts, 'protocol.md'))
  await assert.rejects(compileAgentPackage(pack), /escapes prompts/)
})

test('source files reject invalid UTF-8 and enforce manifest and prompt size limits', async t => {
  const { pack, prompts } = await fixture(t)
  await writeFile(path.join(prompts, 'task.md'), Buffer.from([0xc3, 0x28]))
  await assert.rejects(compileAgentPackage(pack), /valid UTF-8/)
  await writeFile(path.join(prompts, 'task.md'), `${'x'.repeat(256 * 1024)}{{input}}`)
  await assert.rejects(compileAgentPackage(pack), /per-file size limit/)
  await writeFile(path.join(pack, 'agent-package.json'), 'x'.repeat(128 * 1024 + 1))
  await assert.rejects(compileAgentPackage(pack), /file within the size limit/)
})

test('cache keys include same-size prompt changes and source versions; memory is bounded and clearable', async t => {
  clearMemoryCache()
  const { pack } = await fixture(t, { task: 'Task={{input}}' })
  const first = await compileAgentPackage(pack)
  assert.equal(first.cache.status, 'compiled')
  assert.equal(first.cache.compiledTemplates, 3)
  const memory = await compileAgentPackage(pack)
  assert.equal(memory.cache.status, 'memory')
  assert.equal(memory.cache.compiledTemplates, 0)
  await writeFile(path.join(pack, 'prompts', 'task.md'), 'User={{input}}')
  const changedPrompt = await compileAgentPackage(pack)
  assert.equal(Buffer.byteLength('Task={{input}}'), Buffer.byteLength('User={{input}}'))
  assert.notEqual(changedPrompt.fingerprint, first.fingerprint)
  const changedManifest = manifestBase()
  changedManifest.source.version = '1.4.1'
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify(changedManifest))
  const changedSourceVersion = await compileAgentPackage(pack)
  assert.notEqual(changedSourceVersion.fingerprint, changedPrompt.fingerprint)
  assert.ok(clearMemoryCache() >= 3)
})

test('memory cache keeps only the newest 128 compiled programs', async t => {
  clearMemoryCache()
  const { pack } = await fixture(t)
  await compileAgentPackage(pack)
  for (let version = 1; version <= 128; version++) {
    const manifest = manifestBase()
    manifest.version = `0.2.${version}`
    await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify(manifest))
    const result = await compileAgentPackage(pack)
    assert.equal(result.cache.entries, Math.min(version + 1, 128))
  }
  const original = manifestBase()
  await writeFile(path.join(pack, 'agent-package.json'), JSON.stringify(original))
  assert.equal((await compileAgentPackage(pack)).cache.status, 'compiled', 'oldest entry was evicted')
})

test('disk cache is atomic-derived data and corrupted IR is rejected and rebuilt', async t => {
  clearMemoryCache()
  const { root, pack } = await fixture(t)
  const cacheDir = path.join(root, 'cache')
  const first = await compileAgentPackage(pack, { cacheDir })
  assert.equal(first.cache.status, 'compiled')
  assert.equal(first.cache.compiledTemplates, 3)
  clearMemoryCache()
  const disk = await compileAgentPackage(pack, { cacheDir })
  assert.equal(disk.cache.status, 'disk')
  assert.equal(disk.cache.compiledTemplates, 0)
  const envelope = JSON.parse(await readFile(disk.cache.path, 'utf8'))
  envelope.program.prompts.task[0].value = 'tampered'
  envelope.programHash = digest(stable(envelope.program))
  await writeFile(disk.cache.path, JSON.stringify(envelope))
  clearMemoryCache()
  const rebuilt = await compileAgentPackage(pack, { cacheDir })
  assert.equal(rebuilt.cache.status, 'compiled')
  assert.equal(rebuilt.cache.compiledTemplates, 3)
  assert.match(renderProgram(rebuilt.program, { input: 'safe' }), /Input=safe/)
  clearMemoryCache()
  assert.equal((await compileAgentPackage(pack, { cacheDir })).cache.status, 'disk')
})
