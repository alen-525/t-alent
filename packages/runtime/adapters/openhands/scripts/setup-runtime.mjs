import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const distributions = [
  { name: 'openhands-sdk', version: '1.51.0', file: 'openhands_sdk-1.51.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/9d/45/1628c602fa04c3449b7b45da8db04e4fb4beccd41e39861421f49ba1bcb6/openhands_sdk-1.51.0-py3-none-any.whl', sha256: '7757a729e8767816979ae9bb9a0f38c44941c5ec1df9aed1c51b9af3204552b9' },
  { name: 'openhands-tools', version: '1.51.0', file: 'openhands_tools-1.51.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/45/76/5527c743ba4364a7668cd0b952bae4f6f4dd995635d300782bcce4301a2b/openhands_tools-1.51.0-py3-none-any.whl', sha256: '6935f6786ce2c065bfd531303a83934a832e49dcdad62a6c17b07dc6b28a25ae' },
]
let stateDir = process.env.TALENT_STATE_DIR
let basePython = process.env.TALENT_PYTHON ?? 'python3'
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--python') basePython = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <packageStateDir>')
stateDir = resolve(stateDir)
const runtimeDir = resolve(stateDir, 'openhands-runtime'), venv = resolve(runtimeDir, 'venv'), python = resolve(venv, 'bin', 'python')
const downloadDir = resolve(runtimeDir, 'wheels')
await mkdir(downloadDir, { recursive: true, mode: 0o700 })
await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
await run(basePython, ['-m', 'venv', venv])
const wheelPaths = []
for (const item of distributions) {
  const target = resolve(downloadDir, item.file)
  const response = await fetch(item.url, { redirect: 'error' })
  if (!response.ok) throw new Error(`Could not download ${item.name} ${item.version}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== item.sha256) throw new Error(`${item.name} wheel SHA256 mismatch: ${actual}`)
  await writeFile(target, bytes, { mode: 0o600 })
  wheelPaths.push(target)
}
await run(python, ['-m', 'pip', 'install', ...wheelPaths])
const versions = await capture(python, ['-c', 'import importlib.metadata as m; print(m.version("openhands-sdk")); print(m.version("openhands-tools"))'])
if (versions.trim().split(/\s+/).join('|') !== '1.51.0|1.51.0') throw new Error(`OpenHands runtime version check failed: ${versions}`)
await rm(downloadDir, { recursive: true, force: true })
await writeFile(resolve(runtimeDir, 'runtime.json'), JSON.stringify({ python, pythonVersion: (await capture(python, ['--version'])).trim(), openhandsSdk: '1.51.0', openhandsTools: '1.51.0' }, null, 2) + '\n', { mode: 0o600 })
console.log(`Installed OpenHands SDK 1.51.0 and Tools 1.51.0 in ${venv}`)

async function run(command, args) { const child = spawn(command, args, { stdio: 'inherit', shell: false }); const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`${command} exited with code ${code}`) }
async function capture(command, args) { const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], shell: false }); let text = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => text += chunk); const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`${command} exited with code ${code}`); return text }
