import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packages = [
  { name: 'autogen-agentchat', version: '0.7.5', file: 'autogen_agentchat-0.7.5-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/9e/82/23490a70837d77d691948863d393cef71a06d36903249f635b28f579292b/autogen_agentchat-0.7.5-py3-none-any.whl', sha256: 'd19ca8ec26cb15e071a56c4269140aea2bf3c718bdc7e06f6677af9a905815ba' },
  { name: 'autogen-ext', version: '0.7.5', file: 'autogen_ext-0.7.5-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/5c/10/9333ba6c532086cce7ec7fb39e36b9a08afdbc39e2d3519f00af712e403a/autogen_ext-0.7.5-py3-none-any.whl', sha256: '18cecc8aab37c7c4861fbad038a1017f0ef25e35e273aa158066ccf9d93fea4f' },
  { name: 'autogen-core', version: '0.7.5', file: 'autogen_core-0.7.5-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/33/83/8ad899fca9dd2d2b3e5e37be13dd9e6aee3e53a621041b0624d74b07e1ee/autogen_core-0.7.5-py3-none-any.whl', sha256: '4f4a0d3b88a36da75b2ef0d40be2d5e3a207cae7f7d951511e498ad1d68f8ef4' },
  { name: 'openai', version: '3.26.0', file: 'openai-3.26.0-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/fd/37/08c6d71d542b079364221fcbaee863ead900b53cd89db17f4bd0ec83f41a/openai-3.26.0-py3-none-any.whl', sha256: '050597ff71ff4025177405a41fa4019d4f9feae5826645b63b8e35b6e9a3c88b' },
]
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let stateDir = process.env.TALENT_STATE_DIR
let python = process.env.TALENT_MAGENTIC_ONE_PYTHON ?? process.env.TALENT_PYTHON ?? 'python3'
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--python') python = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <state-dir> or set TALENT_STATE_DIR')
const runtimeDir = resolve(stateDir, 'magentic-one-runtime')
const venv = resolve(runtimeDir, 'venv')
const venvPython = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const temp = await mkdtemp(join(tmpdir(), 'talent-magentic-one-'))
try {
  const pyVersion = await capture(python, ['-c', 'import sys; print(".".join(map(str,sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3,10) else 1)'])
  const wheels = []
  for (const item of packages) {
    const response = await fetch(item.url, { redirect: 'error' })
    if (!response.ok) throw new Error(`Could not download ${item.name} ${item.version}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== item.sha256) throw new Error(`${item.name} wheel SHA256 mismatch: ${actual}`)
    const path = join(temp, item.file)
    await writeFile(path, bytes, { mode: 0o600 })
    wheels.push(path)
  }
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  await rm(venv, { recursive: true, force: true })
  await run(python, ['-m', 'venv', venv])
  await run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', ...wheels])
  await run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', resolve(packageDir, 'requirements-runtime.txt')])
  const installed = (await capture(venvPython, ['-c', 'import importlib.metadata as m; from autogen_agentchat.teams import MagenticOneGroupChat; from autogen_ext.agents.magentic_one import MagenticOneCoderAgent; from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor; from autogen_ext.models.openai import OpenAIChatCompletionClient; print("|".join(f"{n}=={m.version(n)}" for n in ["autogen-agentchat","autogen-ext","autogen-core","openai"]))'])).trim()
  if (!installed.split('|').slice(0, 3).every(line => line.endsWith('==0.7.5')) || !installed.includes('openai==3.26.0')) throw new Error(`Installed runtime version mismatch: ${installed}`)
  const installedRows = JSON.parse(await capture(venvPython, ['-m', 'pip', 'list', '--format=json']))
  const lock = installedRows.filter(item => item.name.toLowerCase() !== 'pip').map(item => `${item.name}==${item.version}`).sort()
  await writeFile(resolve(runtimeDir, 'runtime.json'), JSON.stringify({ packages, runtimeLock: lock, python: pyVersion.trim(), pythonExecutable: venvPython }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Installed verified AutoGen 0.7.5 Magentic-One runtime in ${venv}`)
} finally { await rm(temp, { recursive: true, force: true }) }

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, env: cleanEnv() })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`)
}
async function capture(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: cleanEnv() })
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk)
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code}): ${output.slice(-3000)}`)
  return output
}
function cleanEnv() { const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(?:OPENAI|ANTHROPIC|LITELLM|AUTOGEN|MAGENTIC_ONE|TALENT_MAGENTIC_ONE|AWS|AZURE|GOOGLE|GCP|HF|HUGGINGFACE|COHERE|MISTRAL|GEMINI|GROQ|DEEPSEEK|XAI|TOGETHER|FIREWORKS|OPENROUTER)_/i.test(key) || /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key]; return env }
function once(target, event) { return new Promise(resolveEvent => target.once(event, (...args) => resolveEvent(args))) }
