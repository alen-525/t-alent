import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.21.3'
const ARCHIVE_URL = 'https://codeload.github.com/NousResearch/hermes-agent/tar.gz/345cd2b057a452236de401d3534b8502a7465e8d'
const ARCHIVE_SHA256 = 'ed17fdd4423bfc7faee02399a866d5ee30a04a09523da6ea39d794f664526e55'
const runtimeRoot = (stateDir) => join(resolve(stateDir), 'hermes-runtime')

function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-5000)}`)))
  })
}
async function hash(path) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
async function fetchArchive(path) {
  const response = await fetch(ARCHIVE_URL, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Hermes release archive download failed with HTTP ${response.status}`)
  await pipeline(response.body, createWriteStream(path, { mode: 0o600 }))
  const actual = await hash(path)
  if (actual !== ARCHIVE_SHA256) throw new Error(`Hermes archive SHA256 mismatch: ${actual}`)
}

const stateDir = option('--state-dir')
if (!stateDir) throw new Error('usage: setup-runtime.mjs --state-dir <path> [--python <python3.12>]')
const root = runtimeRoot(stateDir)
const source = join(root, 'source')
const venv = join(root, 'venv')
const python = option('--python') || process.env.TALENT_PYTHON || 'python3'
const childEnv = { ...process.env, BROWSER: '/usr/bin/true', HOME: join(root, 'home'), HERMES_HOME: join(root, 'home', '.hermes'), PYTHONNOUSERSITE: '1' }
await mkdir(root, { recursive: true, mode: 0o700 })
await mkdir(childEnv.HOME, { recursive: true, mode: 0o700 })
let pythonInfo
try { pythonInfo = await run(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { env: childEnv }) }
catch (error) { throw new Error(`Python runtime was not found at ${python}: ${error.message}`) }
const [major, minor] = pythonInfo.stdout.trim().split('.').map(Number)
if (major !== 3 || minor < 11 || minor >= 14) throw new Error(`Hermes Agent requires Python >=3.11,<3.14; got ${pythonInfo.stdout.trim()}`)

const stamp = join(root, 'source.sha256')
let sourceReady = false
try { sourceReady = (await readFile(stamp, 'utf8')).trim() === ARCHIVE_SHA256 && await stat(join(source, 'run_agent.py')).then(() => true, () => false) } catch {}
if (!sourceReady) {
  const archive = join(root, `hermes-${VERSION}.tar.gz`)
  await fetchArchive(archive)
  const staging = join(root, `.source-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  await run('tar', ['-xzf', archive, '-C', staging, '--strip-components=1'])
  const pyproject = await readFile(join(staging, 'pyproject.toml'), 'utf8')
  if (!pyproject.includes(`version = "${VERSION}"`) || !pyproject.includes('name = "hermes-agent"')) throw new Error('Hermes source archive metadata does not match the pinned release')
  await rm(source, { recursive: true, force: true })
  await rename(staging, source)
  await writeFile(stamp, `${ARCHIVE_SHA256}\n`, { mode: 0o600 })
  await chmod(stamp, 0o600)
}
const venvPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
if (!await stat(venvPython).then(() => true, () => false)) await run(python, ['-m', 'venv', venv], { env: childEnv })
const requirements = join(root, 'upstream-requirements.txt')
const dependencyText = await run(venvPython, ['-c', 'import pathlib,tomllib; p=pathlib.Path(__import__("sys").argv[1]); d=tomllib.loads(p.read_text()); print("\\n".join(d["project"]["dependencies"]))', join(source, 'pyproject.toml')], { env: childEnv })
await writeFile(requirements, dependencyText.stdout, { mode: 0o600 })
await run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--requirement', requirements], { env: childEnv })
await run(venvPython, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import tomllib,pathlib; p=pathlib.Path(sys.argv[1]); assert tomllib.loads((p/"pyproject.toml").read_text())["project"]["version"] == "0.21.3"; import run_agent; from run_agent import AIAgent; print("Hermes AIAgent ready")', source], { env: { ...childEnv, TALENT_HERMES_SOURCE: source, PYTHONPATH: source } })
process.stdout.write(`Hermes Agent ${VERSION} source verified and private runtime ready at ${venv}\n`)
