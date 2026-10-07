import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const version = '1.26.0'
const artifact = {
  name: 'smolagents', version, file: 'smolagents-1.26.0-py3-none-any.whl',
  url: 'https://files.pythonhosted.org/packages/89/8c/72bd5edc13288e3f27d4d9c1ef65adc0a68c950ee1fc6d3be270e1110f6c/smolagents-1.26.0-py3-none-any.whl',
  sha256: '70e1cfb1576f782da93190ee31d9bb2659e5ca4bd84fda0c412e1f20498f28b6',
}
let stateDir = process.env.TALENT_STATE_DIR
let basePython = process.env.TALENT_SMOLAGENTS_PYTHON ?? process.env.TALENT_PYTHON ?? 'python3'
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--python') basePython = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <state-dir> or set TALENT_STATE_DIR')
const runtimeDir = resolve(stateDir, 'smolagents-runtime')
const venv = resolve(runtimeDir, 'venv')
const python = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-smolagents-'))
try {
  const pyVersion = await capture(basePython, ['-c', 'import sys; print(".".join(map(str,sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3,10) else 1)'])
  const response = await fetch(artifact.url, { redirect: 'error' })
  if (!response.ok) throw new Error(`Could not download ${artifact.name} ${version}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.sha256) throw new Error(`smolagents SHA256 mismatch: ${actual}`)
  const wheel = join(temp, artifact.file)
  await writeFile(wheel, bytes, { mode: 0o600 })
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  await rm(venv, { recursive: true, force: true })
  await run(basePython, ['-m', 'venv', venv])
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', wheel, 'openai>=1.58.1'])
  const installed = (await capture(python, ['-c', 'import importlib.metadata as m; import openai; from smolagents import CodeAgent, OpenAIServerModel; print(m.version("smolagents")); print(m.version("openai"))'])).trim().split(/\r?\n/)
  if (installed[0] !== version) throw new Error(`Pinned smolagents version mismatch: ${installed[0]}`)
  await writeFile(resolve(runtimeDir, 'runtime.json'), JSON.stringify({ package: artifact.name, version, wheelUrl: artifact.url, wheelSha256: artifact.sha256, openai: installed[1], python: pyVersion.trim(), pythonExecutable: python }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed smolagents ${version} with OpenAIModel support in ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, env: cleanEnvironment() })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`)
}
async function capture(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: cleanEnvironment() })
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk)
  child.stderr.on('data', chunk => output += chunk)
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code}): ${output.slice(-3000)}`)
  return output
}
function cleanEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key]
  return env
}
function once(target, event) { return new Promise(resolveEvent => target.once(event, (...args) => resolveEvent(args))) }
