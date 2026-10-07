import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const version = '0.4.3'
const artifacts = [
  { name: 'open-interpreter', version, filename: 'open_interpreter-0.4.3-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/4f/37/193d392bc8428509739f22f07902ff7e3daee6ee3e7c176c08ef3f0c0a8a/open_interpreter-0.4.3-py3-none-any.whl', sha256: 'bb694b826b11986a305b7d34acbabae830481bb1180b52fe1b912e882a21b590' },
  { name: 'setuptools', version: '80.9.0', filename: 'setuptools-80.9.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/a3/dc/17031897dae0efacfea57dfd3a82fdd2a2aeb58e0ff71b77b87e44edc772/setuptools-80.9.0-py3-none-any.whl', sha256: '062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922' },
]
const args = process.argv.slice(2)
let stateDir = process.env.TALENT_STATE_DIR
let python = process.env.TALENT_PYTHON
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--state-dir') stateDir = args[++i]
  else if (args[i] === '--python') python = args[++i]
  else throw new Error(`Unknown setup option: ${args[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <stateDir> or set TALENT_STATE_DIR')
python ??= await findPython()
if (!python) throw new Error('Open Interpreter 0.4.3 requires CPython >=3.9,<4. Pass --python <supported Python> or TALENT_PYTHON.')
const runtime = resolve(stateDir, 'open-interpreter-runtime')
const venv = resolve(runtime, 'venv')
const py = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-open-interpreter-'))
try {
  const pyVersion = await run(python, ['--version'])
  const match = pyVersion.match(/Python (\d+)\.(\d+)/)
  if (!match || Number(match[1]) !== 3 || Number(match[2]) < 9 || Number(match[2]) >= 13) throw new Error(`Unsupported Python ${pyVersion.trim()}; use an upstream-classified version >=3.9,<3.13.`)
  const wheels = []
  for (const artifact of artifacts) {
    const response = await fetch(artifact.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${artifact.name} wheel download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== artifact.sha256) throw new Error(`${artifact.name} ${artifact.version} wheel SHA-256 mismatch: ${digest}`)
    const wheel = join(temp, artifact.filename)
    await writeFile(wheel, bytes, { mode: 0o600 })
    wheels.push(wheel)
  }
  await mkdir(runtime, { recursive: true })
  await run(python, ['-m', 'venv', venv])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...wheels])
  const installed = await run(py, ['-c', 'import importlib.metadata as m; print(m.version("open-interpreter"))'])
  if (installed.trim() !== version) throw new Error(`Unexpected Open Interpreter runtime version: ${installed.trim()}`)
  await writeFile(resolve(runtime, 'runtime.json'), JSON.stringify({ python: pyVersion.trim(), packages: artifacts.map(({ name, version, sha256 }) => ({ name, version, sha256 })) }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed Open Interpreter Python runtime ${version} in ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

async function findPython() {
  for (const candidate of process.platform === 'win32' ? ['py', 'python3.12', 'python3.11', 'python3'] : ['python3.12', 'python3.11', 'python3']) {
    try { const argv = candidate === 'py' ? ['-3', '--version'] : ['--version']; const output = await run(candidate, argv); const found = output.match(/Python (\d+)\.(\d+)/); if (found && Number(found[1]) === 3 && Number(found[2]) >= 9 && Number(found[2]) < 13) return candidate } catch {}
  }
}
async function run(command, argv) { return new Promise((resolveRun, reject) => { const proc = spawn(command, argv, { shell: false, env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; proc.stdout.on('data', chunk => output += chunk); proc.stderr.on('data', chunk => output += chunk); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${output.slice(-4000)}`))) }) }
