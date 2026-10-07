import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const artifacts = [
  { name: 'deepagents', version: '0.7.21', url: 'https://files.pythonhosted.org/packages/d8/8d/5ad6f7271abe3d3b584c05661bc2fb0e75be7847581659e5de83c44f4592/deepagents-0.7.21-py3-none-any.whl', sha256: 'c8e6a89c75c62c232f6197a21af5f1298fda7eb7f1bfbc321bbabf1fa70eefed' },
  { name: 'langchain-openai', version: '1.6.7', url: 'https://files.pythonhosted.org/packages/18/d9/b3db61c6c15766c999194a9cba0b9c5035567b7e0dd1c1a94a6d76448cd6/langchain_openai-1.6.7-py3-none-any.whl', sha256: 'e1b9b318fafc47b2dbc3485778aa23f809195065ee313611c188af29744b8e8e' },
  { name: 'langgraph-checkpoint-sqlite', version: '3.1.1', url: 'https://files.pythonhosted.org/packages/f5/b9/e458601a1718337839bcfeec9d1b27b8b16ce135be2bd50ed0395d33a878/langgraph_checkpoint_sqlite-3.1.1-py3-none-any.whl', sha256: '8505c54c94a658080525d7e6780fdd4e0c078ff2566b30d399c02cc9f9af1c63' },
]
const args = process.argv.slice(2)
let stateDir = process.env.TALENT_STATE_DIR
let python = process.env.TALENT_DEEPAGENTS_PYTHON
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--state-dir') stateDir = args[++i]
  else if (args[i] === '--python') python = args[++i]
  else throw new Error(`Unknown setup option: ${args[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <stateDir> or set TALENT_STATE_DIR')
python ??= await findPython()
if (!python) throw new Error('Deep Agents v0.7.21 requires Python >=3.11. Pass --python <supported CPython> or TALENT_DEEPAGENTS_PYTHON; system python3 is not used as fallback.')
const state = resolve(stateDir)
const runtime = resolve(state, 'deepagents-runtime')
const venv = resolve(runtime, 'venv')
const py = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-deepagents-'))
try {
  const pyVersion = await run(python, ['--version'])
  const version = pyVersion.match(/Python (\d+)\.(\d+)/)
  if (!version || Number(version[1]) !== 3 || Number(version[2]) < 11) throw new Error(`Unsupported Python ${pyVersion.trim()}; Deep Agents requires Python >=3.11.`)
  const wheels = []
  for (const artifact of artifacts) {
    const response = await fetch(artifact.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${artifact.name} wheel download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== artifact.sha256) throw new Error(`${artifact.name} ${artifact.version} wheel SHA-256 mismatch: ${digest}`)
    const path = join(temp, artifact.url.split('/').at(-1))
    await writeFile(path, bytes, { mode: 0o600 })
    wheels.push(path)
  }
  await mkdir(dirname(runtime), { recursive: true })
  await run(python, ['-m', 'venv', venv])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip'])
  await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', ...wheels])
  const installed = await run(py, ['-c', 'import deepagents; print(deepagents.__version__)'])
  if (!installed.includes('0.7.21')) throw new Error(`Unexpected installed Deep Agents SDK: ${installed.trim()}`)
  await writeFile(resolve(runtime, 'runtime.json'), JSON.stringify({ python: pyVersion.trim(), packages: artifacts.map(({ name, version, sha256 }) => ({ name, version, sha256 })) }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed pinned Deep Agents SDK v0.7.21 in ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

async function findPython() {
  for (const candidate of process.platform === 'win32' ? ['py', 'python3.12', 'python3.11'] : ['python3.12', 'python3.11']) {
    try { const args = candidate === 'py' ? ['-3.12', '--version'] : ['--version']; const out = await run(candidate, args); const match = out.match(/Python (\d+)\.(\d+)/); if (match && Number(match[1]) === 3 && Number(match[2]) >= 11) return candidate } catch {}
  }
}
async function run(command, argv) { return await new Promise((resolveRun, reject) => { const proc = spawn(command, argv, { shell: false, env: { ...process.env, BROWSER: '/usr/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'] }); let out=''; proc.stdout.on('data', c => out += c); proc.stderr.on('data', c => out += c); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveRun(out) : reject(new Error(`${command} ${argv.join(' ')} failed (${code}): ${out.slice(-4000)}`))) }) }
