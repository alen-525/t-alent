import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const version = '2.4.6'
const wheelUrl = 'https://files.pythonhosted.org/packages/a2/00/a2f454775f69f540ab529c5f5e35d672f6491f0e6edab7cb196a0d2a0e2e/mini_swe_agent-2.4.6-py3-none-any.whl'
const wheelSha256 = 'a35463c553ac825c7773b03cfa69cd44958e3af20155dcc5711fdf9e4c67cd54'
const args = process.argv.slice(2)
let stateDir = process.env.TALENT_STATE_DIR
let python = process.env.TALENT_PYTHON ?? 'python3'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state-dir') stateDir = args[++i]
  else if (args[i] === '--python') python = args[++i]
  else throw new Error(`Unknown setup option: ${args[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <stateDir> or set TALENT_STATE_DIR')
const runtime = resolve(stateDir, 'mini-swe-agent-runtime')
const venv = resolve(runtime, 'venv')
const pythonBin = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-mini-swe-agent-'))
try {
  const pythonVersion = await run(python, ['--version'])
  const wheelPath = join(temp, `mini_swe_agent-${version}-py3-none-any.whl`)
  const response = await fetch(wheelUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`PyPI wheel download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== wheelSha256) throw new Error(`Pinned mini-swe-agent wheel SHA-256 mismatch: ${digest}`)
  await writeFile(wheelPath, bytes, { mode: 0o600 })
  await rm(runtime, { recursive: true, force: true })
  await mkdir(dirname(runtime), { recursive: true })
  await run(python, ['-m', 'venv', venv])
  await run(pythonBin, ['-m', 'pip', 'install', '--disable-pip-version-check', wheelPath])
  const installed = await run(pythonBin, ['-c', 'import importlib.metadata; print(importlib.metadata.version("mini-swe-agent"))'])
  if (installed.trim() !== version) throw new Error(`Installed mini-swe-agent reports unexpected version ${installed.trim()}`)
  await writeFile(resolve(runtime, 'runtime.json'), JSON.stringify({ name: 'mini-swe-agent', version, python: pythonVersion.trim(), wheelUrl, wheelSha256 }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed mini-swe-agent ${version} into ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

function run(command, argv) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => output += chunk)
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${output.slice(-4000)}`)))
  })
}
