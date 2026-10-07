import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileAgentPackage } from '../packages/runtime/agent-compiler.mjs'
import { agentIds, validateSourceRecord } from './agent-package-sources.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const ids = agentIds()
const work = await mkdtemp(path.join(tmpdir(), 'talent-pack-agents-'))
const destination = path.join(root, 'dist/packages')
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
})
try {
  await mkdir(destination, { recursive: true })
  const archives = []
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  for (const id of ids) {
    const packPath = path.join(root, 'packs', id)
    const manifest = JSON.parse(await readFile(path.join(packPath, 'agent-package.json'), 'utf8'))
    assert.equal(manifest.id, id, `${id} manifest id`)
    assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, `${id} recipe version`)
    await validateSourceRecord(root, id, manifest, lock)
    await compileAgentPackage(packPath, { cacheDir: path.join(work, 'cache') })

    const stage = path.join(work, id, 'package')
    await mkdir(stage, { recursive: true })
    await copyFile(path.join(packPath, 'agent-package.json'), path.join(stage, 'agent-package.json'))
    await cp(path.join(packPath, 'prompts'), path.join(stage, 'prompts'), { recursive: true, dereference: true, errorOnExist: true })
    const filename = `t-alent-agent-${id}-${manifest.version}.tar.gz`
    await run('tar', ['-czf', path.join(destination, filename), '-C', path.join(work, id), 'package'], root)
    archives.push(filename)
  }
  const sums = await Promise.all(archives.sort().map(async name => `${createHash('sha256').update(await readFile(path.join(destination, name))).digest('hex')}  ${name}`))
  await writeFile(path.join(destination, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  console.log(`Created ${archives.length} recipe archives and dist/packages/SHA256SUMS.`)
} finally {
  await rm(work, { recursive: true, force: true })
}
