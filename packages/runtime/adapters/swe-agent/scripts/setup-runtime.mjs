import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const sweAgent = {
  name: 'sweagent', version: '1.1.0', file: 'swe-agent-1.1.0.tar.gz',
  url: 'https://codeload.github.com/SWE-agent/SWE-agent/tar.gz/0f3acafacabc0def8cc76b4e48acb4b6cf302cb9',
  sha256: '2b41fb02041ba570268450e150a5a263e35a2ca8daa87c82a9d2dc14f2b7a104',
}
const sweRex = {
  name: 'swe-rex', version: '1.4.0', file: 'swe_rex-1.4.0-py3-none-any.whl',
  url: 'https://files.pythonhosted.org/packages/98/0d/d06ab2aa78138055c297490762cd7b4d8ac58a544783f874c869cdb7b534/swe_rex-1.4.0-py3-none-any.whl',
  sha256: '61261ad03eb23b717b5901cd5d229f24f6e1be2e120aad5c2e5ea3384a1d15ad',
}
let stateDir = process.env.TALENT_STATE_DIR
let basePython = process.env.TALENT_PYTHON ?? 'python3'
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--python') basePython = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <state-dir> or set TALENT_STATE_DIR')
const runtimeDir = resolve(stateDir, 'swe-agent-runtime')
const venv = resolve(runtimeDir, 'venv')
const python = process.platform === 'win32' ? resolve(venv, 'Scripts', 'python.exe') : resolve(venv, 'bin', 'python')
const sourceDir = resolve(runtimeDir, 'source')
const artifactDir = resolve(runtimeDir, 'artifacts')
await mkdir(artifactDir, { recursive: true, mode: 0o700 })
await mkdir(sourceDir, { recursive: true, mode: 0o700 })
const pyVersion = await capture(basePython, ['-c', 'import sys; print(".".join(map(str,sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3,11) else 1)'])
const artifacts = []
for (const dist of [sweAgent, sweRex]) {
  const response = await fetch(dist.url, { redirect: 'error' })
  if (!response.ok) throw new Error(`Could not download ${dist.name} ${dist.version}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== dist.sha256) throw new Error(`${dist.name} SHA256 mismatch: ${actual}`)
  const path = resolve(artifactDir, dist.file)
  await writeFile(path, bytes, { mode: 0o600 })
  artifacts.push(path)
}
await rm(venv, { recursive: true, force: true })
await run(basePython, ['-m', 'venv', venv])
const env = {
  ...process.env,
  SWE_AGENT_CONFIG_ROOT: sourceDir,
  SWE_AGENT_CONFIG_DIR: resolve(sourceDir, 'config'),
  SWE_AGENT_TOOLS_DIR: resolve(sourceDir, 'tools'),
  SWE_AGENT_TRAJECTORY_DIR: resolve(runtimeDir, 'trajectories'),
}
await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', artifacts[0], artifacts[1]], env)
const versions = (await capture(python, ['-c', 'import importlib.metadata as m; print(m.version("sweagent")); print(m.version("swe-rex"))'], env)).trim().split(/\r?\n/)
if (versions[0] !== sweAgent.version || versions[1] !== sweRex.version) throw new Error(`Pinned runtime mismatch: ${versions.join(' / ')}`)
// Keep the exact upstream config, tool bundles, and license source alongside
// the isolated installed package. Config/tool paths are data not in wheel installs.
const extraction = spawn(basePython, ['-c', [
  'import pathlib,sys,tarfile',
  'archive,target=sys.argv[1],pathlib.Path(sys.argv[2])',
  'target.mkdir(parents=True,exist_ok=True)',
  'root=target.resolve()',
  'with tarfile.open(archive,"r:gz") as t:',
  ' for m in t.getmembers():',
  '  p=(root/m.name.split("/",1)[-1]).resolve()',
  '  if p != root and root not in p.parents: raise ValueError("unsafe source archive path")',
  '  if m.issym() or m.islnk(): continue',
  '  if m.name.count("/") == 0: continue',
  '  m.name=m.name.split("/",1)[1]',
  '  if m.name: t.extract(m,root)',
].join('\n'), artifacts[0], sourceDir], { stdio: ['ignore', 'inherit', 'inherit'], shell: false })
const [extractCode] = await once(extraction, 'close')
if (extractCode !== 0) throw new Error(`Could not extract fixed SWE-agent source archive (${extractCode})`)
await rm(artifactDir, { recursive: true, force: true })
await mkdir(resolve(runtimeDir, 'trajectories'), { recursive: true, mode: 0o700 })
await writeFile(resolve(runtimeDir, 'runtime.json'), JSON.stringify({
  sweagent: sweAgent.version, sweagentArchiveUrl: sweAgent.url, sweagentSha256: sweAgent.sha256,
  sweAgentCommit: '0f3acafacabc0def8cc76b4e48acb4b6cf302cb9', sweRex: sweRex.version,
  sweRexWheelUrl: sweRex.url, sweRexSha256: sweRex.sha256, python: pyVersion.trim(),
  pythonExecutable: python, sourceDir,
}, null, 2) + '\n', { mode: 0o600 })
console.log(`Installed SWE-agent ${sweAgent.version} and SWE-ReX ${sweRex.version} into ${venv}`)

async function run(command, args, envOverride = process.env) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, env: envOverride })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`)
}
async function capture(command, args, envOverride = process.env) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], shell: false, env: envOverride })
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk)
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`)
  return output
}
