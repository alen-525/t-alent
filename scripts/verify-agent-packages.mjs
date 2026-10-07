import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileAgentPackage } from '../packages/runtime/agent-compiler.mjs'
import { loadPackage } from '../packages/runtime/host.mjs'
import { agentIds, validateSourceRecord } from './agent-package-sources.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const ids = agentIds()
const destination = path.join(root, 'dist/packages')
const temp = await mkdtemp(path.join(tmpdir(), 'talent-verify-agents-'))
const run = (command, args, cwd = root, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
})
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const capture = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: false })
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk)
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)))
})
let loaded = []
try {
  const expected = new Set()
  const sums = new Map()
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  for (const line of (await readFile(path.join(destination, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (t-alent-agent-[a-z0-9-]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.tar\.gz)$/.exec(line)
    assert(match, `invalid checksum row: ${line}`)
    assert(!sums.has(match[2]), `duplicate checksum: ${match[2]}`)
    sums.set(match[2], match[1])
  }
  const workspace = path.join(temp, 'workspace'), stateRoot = path.join(temp, 'state')
  await mkdir(workspace)
  const gooseShim = path.join(temp, 'bin', 'goose')
  await mkdir(path.dirname(gooseShim), { recursive: true })
  await writeFile(gooseShim, '#!/bin/sh\necho "goose version 1.48.0"\n')
  await chmod(gooseShim, 0o755)
  for (const id of ids) {
    const sourceDir = path.join(root, 'packs', id)
    const manifest = JSON.parse(await readFile(path.join(sourceDir, 'agent-package.json'), 'utf8'))
    const archiveName = `t-alent-agent-${id}-${manifest.version}.tar.gz`
    expected.add(archiveName)
    const archivePath = path.join(destination, archiveName)
    const bytes = await readFile(archivePath)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sums.get(archiveName), `${archiveName} SHA-256`)
    const listing = await capture('tar', ['-tzf', archivePath])
    const entries = listing.trim().split('\n')
    const detailed = (await capture('tar', ['-tvzf', archivePath])).trim().split('\n')
    assert.equal(detailed.length, entries.length, `${archiveName} detailed listing count`)
    assert(detailed.every(line => ['-', 'd'].includes(line[0])), `${archiveName} contains only regular files and directories, no links/special files`)
    assert(entries.includes('package/agent-package.json'), `${archiveName} has manifest at package root`)
    assert(entries.includes('package/prompts/'), `${archiveName} has prompts directory`)
    assert(entries.every(entry => (entry === 'package/' || entry === 'package/agent-package.json' || entry === 'package/prompts/' || entry.startsWith('package/prompts/')) && !entry.split('/').some(part => part === '..' || part === '.')), `${archiveName} has only safe recipe paths`)
    assert(entries.filter(entry => entry.endsWith('.md')).length >= 3, `${archiveName} includes recipe prompts`)
    const rawManifest = JSON.parse(await readFile(path.join(sourceDir, 'agent-package.json'), 'utf8'))
    const sourceRecord = await validateSourceRecord(root, id, manifest, lock)
    const unpack = path.join(temp, id)
    await mkdir(unpack)
    await run('tar', ['-xzf', archivePath, '--no-same-owner', '-C', unpack])
    const unpacked = path.join(unpack, 'package')
    const archiveManifest = JSON.parse(await readFile(path.join(unpacked, 'agent-package.json'), 'utf8'))
    assert.equal(canonical(archiveManifest), canonical(rawManifest), `${archiveName} manifest matches source recipe`)
    const compiled = await compileAgentPackage(unpacked, { cacheDir: path.join(temp, 'cache') })
    const localCompiled = await compileAgentPackage(sourceDir, { cacheDir: path.join(temp, 'cache') })
    assert.equal(canonical(compiled.program.prompts), canonical(localCompiled.program.prompts), `${archiveName} compiled prompts match source recipe`)
    assert.equal(canonical(compiled.program.steps), canonical(localCompiled.program.steps), `${archiveName} compiled steps match source recipe`)
    assert.equal(sourceRecord.source.agent, compiled.manifest.source.agent)
    assert.equal(sourceRecord.source.version, compiled.manifest.source.version)
    const config = id === 'goose' ? { goose: { program: gooseShim } }
      : id === 'roo' ? { roo: { program: process.env.ROO_BIN ?? path.join(root, '.talent/roo/roo-runtime/roo-cli-darwin-arm64/bin/roo') } }
      : id === 'aider' ? { aider: { program: process.env.AIDER_BIN ?? path.join(root, '.talent/aider/aider-runtime/venv/bin/aider') } }
      : ['pypi','github'].includes(sourceRecord.source.distribution?.ecosystem) ? { [id]: { python: process.env[`TALENT_${id.replaceAll('-', '_').toUpperCase()}_PYTHON`] ?? path.join(root, '.talent', id, `${id}-runtime/venv/bin/python`) } } : {}
    const packageRuntime = await loadPackage(unpacked, { workspace, stateRoot, env: {}, config })
    loaded.push(packageRuntime)
    assert.equal(packageRuntime.manifest.id, id)
    assert.equal(typeof packageRuntime.runtime.executeTask, 'function')
    assert.equal(typeof packageRuntime.runtime.cancelTask, 'function')
    assert.equal(typeof packageRuntime.runtime.dispose, 'function')
    await packageRuntime.runtime.dispose()
    loaded.pop()
  }
  assert.deepEqual([...sums.keys()].sort(), [...expected].sort(), 'SHA256SUMS contains exactly the registered current archives')
  if (process.argv.includes('--real-smoke')) {
    const gooseBinary = process.env.GOOSE_BIN ?? path.join(root, '.talent/goose/goose-runtime/goose')
    for (const id of ids) await run(process.execPath, [path.join(root, 'packages/runtime/adapters', id, 'scripts/real-runtime-smoke.mjs')], root, { ...process.env, GOOSE_BIN: gooseBinary,
      OPENHANDS_PYTHON: process.env.TALENT_OPENHANDS_PYTHON ?? path.join(root, '.talent/openhands/openhands-runtime/venv/bin/python'),
      DEEPAGENTS_PYTHON: process.env.TALENT_DEEPAGENTS_PYTHON ?? path.join(root, '.talent/deepagents/deepagents-runtime/venv/bin/python'),
      MISTRAL_VIBE_PYTHON: process.env.TALENT_MISTRAL_VIBE_PYTHON ?? path.join(root, '.talent/mistral-vibe/mistral-vibe-runtime/venv/bin/python'),
      ROO_BIN: process.env.ROO_BIN ?? path.join(root, '.talent/roo/roo-runtime/roo-cli-darwin-arm64/bin/roo'),
    })
  }
  console.log(`Verified ${ids.length} recipe-only archives, source locks, compiler output, native adapter load/dispose lifecycle, and checksums.`)
} finally {
  await Promise.allSettled(loaded.map(item => item.runtime.dispose()))
  await rm(temp, { recursive: true, force: true })
}
