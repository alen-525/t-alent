import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const artifacts = {
  'darwin-arm64': ['mistral_vibe-2.25.8-cp312-abi3-macosx_11_0_arm64.whl', 'https://files.pythonhosted.org/packages/e7/87/12fdf1763ccc23bea4396f2ae14b5bc06dd5095b741fcbb6fccc591fe012/mistral_vibe-2.25.8-cp312-abi3-macosx_11_0_arm64.whl', '9b2a3f9c1078e8cf2bd0a2cd860336b3ad8039894ecf423994588be4545d73ea'],
  'darwin-x64': ['mistral_vibe-2.25.8-cp312-abi3-macosx_11_0_x86_64.whl', 'https://files.pythonhosted.org/packages/4c/90/0611fca521027557e1d3d677d79e2a186bc50343cb0f65bd8ec951179299/mistral_vibe-2.25.8-cp312-abi3-macosx_11_0_x86_64.whl', '22a3eef4015ae16cdd3654be41cd5d1bdeb23a18cc5bf845d0cdf291277ed824'],
  'linux-arm64': ['mistral_vibe-2.25.8-cp312-abi3-manylinux_2_28_aarch64.whl', 'https://files.pythonhosted.org/packages/3c/39/05c61cddf0f406361aa6a2faff69c75713de4c9d74c8827f076806487849/mistral_vibe-2.25.8-cp312-abi3-manylinux_2_28_aarch64.whl', 'a73727361c98440d20c376bff69edf92fd18d01c03f81e54e3d47135df2c9f20'],
  'linux-x64': ['mistral_vibe-2.25.8-cp312-abi3-manylinux_2_28_x86_64.whl', 'https://files.pythonhosted.org/packages/cb/7a/3ccfdbb088c6411d1a6acc8ffa88c2c8d793075d9624a53fdb8cd3aea008/mistral_vibe-2.25.8-cp312-abi3-manylinux_2_28_x86_64.whl', 'd0d004cb834e8e7973378bb779411fe97bb4ed9d7e533c121d64c7fbd2ec3dea'],
  'win32-x64': ['mistral_vibe-2.25.8-cp312-abi3-win_amd64.whl', 'https://files.pythonhosted.org/packages/89/10/6858b5316c2ca11ca8e0da93c62eb810e506e77ebd812773b3b860931980/mistral_vibe-2.25.8-cp312-abi3-win_amd64.whl', '6c21acc2bffdfd1a94c9da6d54db51ee4e2542a60165e46d5727ff06e0a57ae1'],
}
let stateDir = process.env.TALENT_STATE_DIR
let basePython = process.env.TALENT_PYTHON ?? 'python3'
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--python') basePython = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <packageStateDir>')
const key = `${process.platform}-${process.arch}`
const artifact = artifacts[key]
if (!artifact) throw new Error(`Mistral Vibe 2.25.8 has no pinned wheel for ${key}`)
stateDir = resolve(stateDir)
const runtimeDir = resolve(stateDir, 'mistral-vibe-runtime'), venv = resolve(runtimeDir, 'venv')
const python = resolve(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const vibeAcp = resolve(venv, process.platform === 'win32' ? 'Scripts/vibe-acp.exe' : 'bin/vibe-acp')
const wheelDir = resolve(runtimeDir, 'wheels'), wheel = resolve(wheelDir, artifact[0])
await mkdir(runtimeDir, { recursive: true, mode: 0o700 }); await mkdir(wheelDir, { recursive: true, mode: 0o700 })
const probeHome = resolve(runtimeDir, 'version-probe')
await mkdir(probeHome, { recursive: true, mode: 0o700 })
const probeEnv = { ...process.env, HOME: probeHome, VIBE_HOME: probeHome, BROWSER: '/usr/bin/true' }
const pythonVersion = (await capture(basePython, ['-c', 'import sys; print(".".join(map(str,sys.version_info[:2])))'])).trim().split('.').map(Number)
if (pythonVersion[0] !== 3 || pythonVersion[1] < 12) throw new Error('Mistral Vibe 2.25.8 requires Python 3.12 or newer')
await run(basePython, ['-m', 'venv', venv])
const response = await fetch(artifact[1], { redirect: 'error' })
if (!response.ok) throw new Error(`Could not download Mistral Vibe 2.25.8 wheel: HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== artifact[2]) throw new Error(`Mistral Vibe wheel SHA256 mismatch: ${actual}`)
await writeFile(wheel, bytes, { mode: 0o600 })
await run(python, ['-m', 'pip', 'install', wheel])
const version = await capture(vibeAcp, ['--version'], probeEnv)
if (!/^vibe-acp(?:\.exe)? 2\.25\.8$/.test(version.trim())) throw new Error(`Mistral Vibe version check failed: ${version.trim()}`)
await rm(wheelDir, { recursive: true, force: true })
await writeFile(resolve(runtimeDir, 'runtime.json'), JSON.stringify({ python, vibeAcp, version: '2.25.8', wheel: artifact[0], sha256: artifact[2] }, null, 2) + '\n', { mode: 0o600 })
console.log(`Installed Mistral Vibe 2.25.8 in ${venv}`)

async function run(command, args) { const child = spawn(command, args, { stdio: 'inherit', shell: false }); const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`${command} exited with code ${code}`) }
async function capture(command, args, env = process.env) { const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'], shell: false }); let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk); const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`${command} exited with code ${code}`); return output }
