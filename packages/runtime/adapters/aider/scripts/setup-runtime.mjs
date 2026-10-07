import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const version = '0.86.2'
const wheelSha256 = '64f6a0c66c9f4633ad9f479bca3e64ebcba02b9da03c6b604b74a44736b2416e'
const wheelUrl = 'https://files.pythonhosted.org/packages/75/f7/e20749d9a510673e7adf910b005e3efe4ceaf9c194f1dd40d6931a3f34b9/aider_chat-0.86.2-py3-none-any.whl'
const args = process.argv.slice(2)
let stateDir = process.env.TALENT_STATE_DIR
let python = process.env.TALENT_AIDER_PYTHON
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--state-dir') stateDir = args[++i]
  else if (args[i] === '--python') python = args[++i]
  else throw new Error(`Unknown setup option: ${args[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <stateDir> or set TALENT_STATE_DIR')
python ??= await findSupportedPython()
if (!python) throw new Error('Aider v0.86.2 requires Python >=3.10,<3.13. Pass --python <supported CPython> or set TALENT_AIDER_PYTHON; system python3 is intentionally not used.')
const state = resolve(stateDir)
const runtime = resolve(state, 'aider-runtime')
const venv = resolve(runtime, 'venv')
const pythonBin = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const aiderBin = process.platform === 'win32' ? resolve(venv, 'Scripts', 'aider.exe') : resolve(venv, 'bin', 'aider')
const temp = await mkdtemp(join(tmpdir(), 'talent-aider-runtime-'))
try {
  const versionOutput = await run(python, ['--version'])
  const match = versionOutput.match(/Python (\d+)\.(\d+)/)
  if (!match || Number(match[1]) !== 3 || Number(match[2]) < 10 || Number(match[2]) >= 13) throw new Error(`Unsupported Python runtime ${versionOutput.trim()}; Aider v${version} requires >=3.10,<3.13.`)
  const wheel = join(temp, `aider_chat-${version}-py3-none-any.whl`)
  const response = await fetch(wheelUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`PyPI wheel download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== wheelSha256) throw new Error(`Pinned Aider wheel SHA-256 mismatch: ${digest}`)
  await writeFile(wheel, bytes, { mode: 0o600 })
  await rm(runtime, { recursive: true, force: true })
  await mkdir(dirname(runtime), { recursive: true })
  await run(python, ['-m', 'venv', venv])
  await run(pythonBin, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'])
  await run(pythonBin, ['-m', 'pip', 'install', '--disable-pip-version-check', wheel])
  const installed = await run(aiderBin, ['--version'])
  if (!new RegExp(`(?:^|\\s)v?${version.replaceAll('.', '\\.')}[\\s$]`).test(installed)) throw new Error(`Installed Aider reports unexpected version: ${installed.trim()}`)
  await writeFile(resolve(runtime, 'runtime.json'), JSON.stringify({ name: 'aider-chat', version, python: versionOutput.trim(), wheelSha256 }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed pinned Aider v${version} into ${venv}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}

async function findSupportedPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python3.12', 'python3.11', 'python3.10'] : ['python3.12', 'python3.11', 'python3.10']
  for (const candidate of candidates) {
    try {
      const output = await run(candidate, candidate === 'py' ? ['-3.12', '--version'] : ['--version'])
      const match = output.match(/Python (\d+)\.(\d+)/)
      if (match && Number(match[1]) === 3 && Number(match[2]) >= 10 && Number(match[2]) < 13) return candidate
    } catch {}
  }
}
async function run(command, argv) {
  return await new Promise((resolveRun, reject) => {
    const child = nodeSpawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => output += chunk)
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${output.slice(-4000)}`)))
  })
}
