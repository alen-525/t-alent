import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { AGENT_IDENTITIES, getAgentIdentity } from './agent-identity.mjs'
import { runCli } from './app.mjs'
import { makeTerminal } from './terminal.mjs'
import { ADAPTERS } from '../../packages/runtime/adapters/registry.mjs'

const PACK_IDS = Object.keys(ADAPTERS)

test('identity registry is distinct, neutral without a package, and sanitizes custom package names', async () => {
  const identities = PACK_IDS.map(id => getAgentIdentity({ id }))
  assert.equal(new Set(identities.map(identity => identity.mark)).size, PACK_IDS.length)
  assert.equal(new Set(identities.map(identity => identity.accent)).size, PACK_IDS.length)
  assert.equal(new Set(identities.map(identity => identity.art.join('\n'))).size, PACK_IDS.length)
  assert.strictEqual(getAgentIdentity(), AGENT_IDENTITIES.talent)
  assert.strictEqual(getAgentIdentity(null), AGENT_IDENTITIES.talent)

  for (const identity of [...identities, AGENT_IDENTITIES.talent]) {
    assert.ok(Array.from(identity.mark).length <= 3)
    assert.match(identity.ansi, /^\u001b\[38;2;\d+;\d+;\d+m$/)
    assert.equal(identity.art.length, 7)
    for (const row of identity.art) assert.ok(Array.from(row).length <= 15)
  }
  const custom = getAgentIdentity({ id: 'team.tool\u001b[31m\nname-with-an-overlong-suffix-123456789' })
  for (const value of [custom.id, custom.label, custom.mark, ...custom.art]) assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/)
  assert.ok(custom.id.length <= 120)
  assert.ok(custom.label.length <= 48)
  assert.ok(custom.mark.length <= 3)
  assert.ok(custom.art.every(row => /^[\x20-\x7e]{15}$/.test(row)))

  for (const id of ['constructor', 'toString', '__proto__', 'CODEX']) {
    const unknown = getAgentIdentity(id)
    assert.equal(typeof unknown, 'object')
    assert.notStrictEqual(unknown, AGENT_IDENTITIES.codex)
    assert.ok(unknown.mark.length <= 3)
  }
  assert.equal(getAgentIdentity('CODEX').mark, 'CO')
  assert.ok(getAgentIdentity('constructor').art.some(row => row.includes('CO')))

  const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'icons')
  for (const id of [...PACK_IDS, 'talent']) {
    const svg = await readFile(path.join(assets, `${id}.svg`), 'utf8')
    assert.match(svg, /^\s*<svg\b/i)
  }
})

test('terminal branding stays within width and NO_COLOR suppresses ANSI sequences', () => {
  const identity = getAgentIdentity('codex')
  for (const columns of [20, 40, 80]) {
    const output = { isTTY: true, columns, value: '', write(text) { this.value += String(text); return true } }
    const terminal = makeTerminal({ input: { isTTY: true }, output })
    terminal.brand({ identity, rows: ['model     Model A', 'harness   Codex', 'directory /work'] })
    for (const line of output.value.split('\n')) assert.ok(terminal.visible(line) <= columns - 1, `line exceeds ${columns - 1} columns: ${line}`)
  }

  const prior = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  try {
    const output = { isTTY: true, columns: 80, value: '', write(text) { this.value += String(text); return true } }
    makeTerminal({ input: { isTTY: true }, output }).brand({ identity, rows: ['Model A'] })
    assert.equal(output.value.includes('\u001b'), false)
  } finally {
    if (prior === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prior
  }
})

test('interactive harness changes update identity while model, clear, and resume keep the selected package', { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'talent-agent-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const stateDir = path.join(root, 'state')
  await Promise.all([mkdir(workspace), mkdir(stateDir)])
  await mkdir(path.join(stateDir, 'cli'), { recursive: true })
  const resumedSession = { id: 'resume-me', title: 'Saved session', packageId: 'deepseek', modelId: 'model-a', workspace, updatedAt: 1 }
  await writeFile(path.join(stateDir, 'cli', 'sessions.json'), JSON.stringify({ version: 1, sessions: [resumedSession], history: [] }))

  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  const output = new PassThrough()
  output.isTTY = true
  output.columns = 80
  output.rows = 24
  let transcript = ''
  output.on('data', chunk => { transcript += chunk })
  const error = { value: '', write(text) { this.value += String(text) } }
  let executeCount = 0
  const client = {
    workspace,
    packages: PACK_IDS.slice(0, 2).map(id => ({ manifest: { id, name: getAgentIdentity(id).label }, runtimeReady: true })),
    models: [
      { id: 'model-a', name: 'Model A', provider: 'test', model: 'a', protocol: 'test' },
      { id: 'model-b', name: 'Model B', provider: 'test', model: 'b', protocol: 'test' },
    ],
    async *executeTask() { executeCount++ },
    async cancelTask() {},
  }

  const task = runCli({ client, options: { resume: resumedSession.id, stateDir }, input, output, error })
  const waitForKeypress = async (expected, description) => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const count = input.listenerCount('keypress')
      if (expected ? count > 0 : count === 0) return
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error(`Timed out waiting for ${description}`)
  }
  const command = async text => {
    await waitForKeypress(true, 'interactive prompt')
    for (const char of text) input.emit('keypress', char, { name: char })
    input.emit('keypress', '\r', { name: 'return' })
    await waitForKeypress(false, 'prompt to finish')
    if (text !== '/quit') await waitForKeypress(true, 'next prompt')
  }
  const clean = value => stripVTControlCharacters(value).replace(/\r/g, '')

  try {
    await waitForKeypress(true, 'initial prompt')
    assert.match(transcript, /DeepSeek/)
    const beforeHarness = transcript
    await command('/harness codex')
    const afterHarness = clean(transcript.slice(beforeHarness.length))
    assert.match(afterHarness, />_ Codex/)
    assert.match(afterHarness, />_ ›/)
    const beforeModel = transcript
    await command('/model model-b')
    const afterModel = clean(transcript.slice(beforeModel.length))
    assert.match(afterModel, />_ Codex/)
    assert.match(afterModel, />_ ›/)
    assert.doesNotMatch(afterModel, /DeepSeek/)
    const beforeClear = transcript
    await command('/clear')
    const afterClear = clean(transcript.slice(beforeClear.length))
    assert.match(afterClear, />_ Codex/)
    assert.match(afterClear, />_ ›/)
    const beforeResume = transcript
    await command('/resume resume-me')
    const afterResume = clean(transcript.slice(beforeResume.length))
    assert.match(afterResume, /~> DeepSeek/)
    assert.match(afterResume, /~> ›/)
    await command('/quit')
    assert.equal(await task, 0)
    assert.equal(error.value, '')
    assert.equal(executeCount, 0)
  } finally {
    input.emit('keypress', '\u0003', { name: 'c', ctrl: true })
    let timer
    await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, 1000) })])
    clearTimeout(timer)
  }
})

test('identity prompt prefix remains visible when a submitted line is committed', { timeout: 5000 }, async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  const output = new PassThrough()
  output.isTTY = true
  output.columns = 80
  let rendered = ''
  output.on('data', chunk => { rendered += chunk })
  const terminal = makeTerminal({ input, output })
  const pending = terminal.readLine({ prefix: '~> ' })
  input.emit('keypress', 'g', { name: 'g' })
  input.emit('keypress', 'o', { name: 'o' })
  input.emit('keypress', '\r', { name: 'return' })
  assert.equal((await pending).value, 'go')
  assert.match(stripVTControlCharacters(rendered).replace(/\r/g, ''), /~> go\n$/)
})
