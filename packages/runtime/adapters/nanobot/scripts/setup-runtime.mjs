import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const VERSION = '0.3.5'
const artifact = {
  name: 'nanobot-ai', version: VERSION,
  filename: 'nanobot_ai-0.3.5.tar.gz',
  url: 'https://files.pythonhosted.org/packages/source/n/nanobot-ai/nanobot_ai-0.3.5.tar.gz',
  sha256: '5d5d92ba163937421c99404ac026dc4723d3b23b83c13a0be3111237401a1dc0',
}
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
if (!python) throw new Error('nanobot-ai 0.3.5 requires Python >=3.11. Pass --python <python> or set TALENT_PYTHON.')
const runtime = resolve(stateDir, 'nanobot-runtime')
const venv = resolve(runtime, 'venv')
const py = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-nanobot-'))
try {
  const versionOutput = await run(python, ['--version'])
  const match = versionOutput.match(/Python (\d+)\.(\d+)/)
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 11)) throw new Error(`Unsupported Python ${versionOutput.trim()}; nanobot-ai requires Python >=3.11.`)
  const response = await fetch(artifact.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`nanobot-ai source distribution download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) throw new Error(`nanobot-ai ${VERSION} source distribution SHA-256 mismatch: ${digest}`)
  const source = join(temp, artifact.filename)
  await writeFile(source, bytes, { mode: 0o600 })
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await run(python, ['-m', 'venv', venv])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', source])
  const installed = await run(py, ['-c', 'import importlib.metadata as m; print(m.version("nanobot-ai"))'])
  if (installed.trim() !== VERSION) throw new Error(`Unexpected nanobot-ai runtime version: ${installed.trim()}`)
  await writeFile(resolve(runtime, 'runtime.json'), JSON.stringify({ python: versionOutput.trim(), package: { name: artifact.name, version: VERSION, sourceSha256: artifact.sha256 } }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed nanobot-ai ${VERSION} in ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

async function findPython() {
  for (const candidate of process.platform === 'win32' ? ['py', 'python3', 'python'] : ['python3', 'python']) {
    try {
      const argv = candidate === 'py' ? ['-3', '--version'] : ['--version']
      const output = await run(candidate, argv)
      const found = output.match(/Python (\d+)\.(\d+)/)
      if (found && (Number(found[1]) > 3 || Number(found[1]) === 3 && Number(found[2]) >= 11)) return candidate
    } catch {}
  }
}
async function run(command, argv) {
  return new Promise((resolveRun, reject) => {
    const proc = spawn(command, argv, { shell: false, env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    proc.stdout.on('data', chunk => output += chunk)
    proc.stderr.on('data', chunk => output += chunk)
    proc.once('error', reject)
    proc.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${output.slice(-4000)}`)))
  })
}
