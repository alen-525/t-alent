import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.86.2'

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  const state = resolve(stateDir)
  const executable = config.program ?? env?.AIDER_BIN ?? process.env.AIDER_BIN ?? resolve(state, 'aider-runtime', 'venv', 'bin', 'aider')
  await assertVersion(executable)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: executable, spawnProcess: nodeSpawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Aider runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'aider')
  const sessionFile = resolve(state, 'sessions.json')
  await mkdir(state, { recursive: true })
  const sessions = await readSessions(sessionFile)
  const hostEnv = { ...process.env, ...(env ?? {}) }
  const graceMs = Number.isSafeInteger(config.cancelGraceMs) && config.cancelGraceMs > 0 ? Math.min(config.cancelGraceMs, 60_000) : 5_000
  let active = null
  let disposed = false

  async function persist() {
    const tmp = `${sessionFile}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 })
    await rename(tmp, sessionFile)
  }

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Aider agent package is disposed')
    if (active) throw new Error(`Aider agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = hostEnv[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileId = fingerprint(profile)
    const conversationKey = createHash('sha256').update(`${String(sessionId || taskId)}\0${profileId}`).digest('hex')
    const profileDir = resolve(state, 'profiles', profileId)
    const historyPath = resolve(profileDir, `${createHash('sha256').update(conversationKey).digest('hex')}.chat.md`)
    const taskEnv = isolatedEnvironment(hostEnv, profile, profileDir, apiKey)
    const secrets = findSecrets(hostEnv, apiKey)
    const task = { taskId, profile, apiKey, historyPath, conversationKey, taskEnv, profileDir, secrets, signal, queue: eventQueue(), child: null, closed: false, closePromise: null, childReady: null, signalChildReady: null, finished: null, cancelled: false, settled: false, abortListener: null, cancelPromise: null }
    task.childReady = new Promise(resolveReady => { task.signalChildReady = resolveReady })
    active = task
    task.finished = run(task, input, Boolean(sessions[conversationKey]), root)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() {
      try { while (true) { const item = await task.queue.next(); if (item.done) return; yield item.value } }
      finally { if (!task.settled) await cancelTask(taskId) }
    } }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelled = true
      await Promise.race([task.childReady, task.finished])
      if (task.child && !task.closed) {
        signalProcessTree(task.child, 'SIGINT')
        if (!await waitForClose(task.closePromise, graceMs)) {
          signalProcessTree(task.child, 'SIGKILL')
          await task.closePromise
        }
      }
      await task.finished
    })()
    await task.cancelPromise
  }

  async function run(task, input, resuming, root) {
    let stdout = ''
    let stderr = ''
    const promptPath = resolve(task.profileDir, `prompt-${randomUUID()}.txt`)
    try {
      await Promise.all([mkdir(task.profileDir, { recursive: true }), mkdir(task.taskEnv.HOME, { recursive: true }), mkdir(task.taskEnv.XDG_CONFIG_HOME, { recursive: true })])
      if (task.cancelled || task.signal?.aborted) return
      await writeFile(promptPath, input, { mode: 0o600 })
      const args = [
        '--config', resolve(task.profileDir, 'empty.yaml'), '--env-file', resolve(task.profileDir, 'empty.env'),
        '--model', `openai/${task.profile.model}`, '--openai-api-base', task.profile.baseUrl ?? 'https://api.openai.com/v1',
        '--message-file', promptPath, '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--no-stream', '--edit-format', 'diff',
        '--no-pretty', '--no-fancy-input', '--no-detect-urls', '--no-analytics', '--no-check-update', '--no-show-release-notes', '--no-show-model-warnings', '--no-gui', '--no-browser', '--disable-playwright',
        '--chat-history-file', task.historyPath, '--input-history-file', resolve(task.profileDir, 'input.history'),
        '--llm-history-file', resolve(task.profileDir, 'llm-history.json'), ...(resuming ? ['--restore-chat-history'] : []),
      ]
      for (const relativePath of await validateRequestedFiles(root, config.files)) args.push('--file', relativePath)
      await writeFile(resolve(task.profileDir, 'empty.yaml'), '{}\n', { mode: 0o600 })
      await writeFile(resolve(task.profileDir, 'empty.env'), '', { mode: 0o600 })
      const child = runtime.spawnProcess(runtime.command, args, { cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      task.child = child
      task.signalChildReady()
      let spawnError
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { spawnError = error })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, error: spawnError }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { if (stdout.length < 2_000_000) stdout += String(chunk).slice(0, 2_000_000 - stdout.length) })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += String(chunk).slice(0, 32_000 - stderr.length) })
      const outcome = await task.closePromise
      if (task.cancelled || task.signal?.aborted) return
      if (outcome.error?.code === 'ENOENT') throw new Error(`Aider v${VERSION} was not found at ${runtime.command}; run setup:runtime or set AIDER_BIN.`)
      if (outcome.code !== 0) throw new Error(redact(`Aider exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`}${stderr.trim() ? `: ${stderr.trim().slice(-4000)}` : ''}`, task.secrets))
      const providerFailure = detectProviderFailure(stdout, stderr)
      if (providerFailure) throw new Error(redact(`Aider reported a model-provider failure: ${providerFailure}`, task.secrets))
      sessions[task.conversationKey] = task.historyPath
      await persist()
      const text = redact(stdout.trim(), task.secrets)
      task.queue.push({ type: 'session', sessionId: task.conversationKey })
      if (text) task.queue.push({ type: 'assistant-replace', text })
      task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) { signalProcessTree(task.child, 'SIGTERM'); await task.closePromise?.catch(() => {}) }
      if (!task.cancelled && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(safeMessage(error), task.secrets) })
    } finally {
      await rm(promptPath, { force: true }).catch(() => {})
      task.signalChildReady?.()
      task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelled && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

async function validateRequestedFiles(root, files = []) {
  if (!Array.isArray(files) || files.length > 40 || files.some(file => typeof file !== 'string' || !file.trim() || file.length > 1000)) throw new TypeError('config.files must be an array of at most 40 workspace-relative file paths')
  const result = []
  const realRoot = await realpath(root)
  for (const file of [...new Set(files)]) {
    const absolute = resolve(realRoot, file)
    const rel = relative(realRoot, absolute)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || absolute === realRoot) throw new TypeError(`Aider file must stay inside the workspace: ${file}`)
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`Aider file must be a regular, non-symlink workspace file: ${file}`)
    const real = await realpath(absolute)
    const realRel = relative(realRoot, real)
    if (realRel === '..' || realRel.startsWith(`..${sep}`)) throw new TypeError(`Aider file must stay inside the workspace: ${file}`)
    if (stat.size > 2_000_000) throw new TypeError(`Aider file is too large to attach: ${file}`)
    result.push(realRel.split(sep).join('/'))
  }
  return result
}

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (value.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${value.protocol}`)
  if (value.provider.trim() !== 'openai') throw new TypeError('Aider adapter supports the external OpenAI Chat Completions route only; provider must be openai')
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string') throw new TypeError('model profile baseUrl must be a string')
    const url = new URL(value.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || value.model.length > 200 || value.id.length > 200 || /[\r\n]/.test(value.model)) throw new TypeError('model profile id/model or apiKeyEnv is invalid')
  return { id: value.id.trim(), provider: 'openai', model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), ...(value.baseUrl ? { baseUrl: value.baseUrl.replace(/\/$/, '') } : {}) }
}

function rejectConfig(config) { for (const key of ['model', 'provider', 'baseUrl', 'baseURL', 'apiKey', 'apiKeyEnv']) if (Object.hasOwn(config, key)) throw new TypeError(`${key} must come from the external model profile`) }
function fingerprint(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex') }
function isolatedEnvironment(host, profile, profileDir, apiKey) {
  const child = { ...host }
  for (const key of Object.keys(child)) if (/^(AIDER_|OPENAI_)/i.test(key) || /API_BASE|BASE_URL|ENDPOINT|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete child[key]
  const home = resolve(profileDir, 'home')
  child.HOME = home
  child.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  child.XDG_CACHE_HOME = resolve(profileDir, 'xdg-cache')
  child.AIDER_HOME = home
  child.OPENAI_API_KEY = apiKey
  child.OPENAI_API_BASE = profile.baseUrl ?? 'https://api.openai.com/v1'
  child.AIDER_ANALYTICS = 'false'
  child.AIDER_CHECK_UPDATE = 'false'
  child.AIDER_SHOW_RELEASE_NOTES = 'false'
  child.BROWSER = '/usr/bin/true'
  child.NO_COLOR = '1'
  child.TERM = 'dumb'
  return child
}
function findSecrets(env, key) { return [...new Set([key, ...Object.entries(env).filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)].filter(value => value.length >= 4))] }
function redact(text, secrets) { return secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), String(text)) }
function safeMessage(error) { return error instanceof Error ? error.message : String(error) }
function detectProviderFailure(stdout, stderr) {
  const text = `${stdout}\n${stderr}`
  const match = text.match(/^\s*(litellm\.[A-Za-z]+(?:Error|Exception)[^\n]*|OpenAIException[^\n]*|The API provider is not able to authenticate you\.[^\n]*)/im)
  return match?.[1]?.trim()
}
async function readSessions(path) { try { const data = JSON.parse(await readFile(path, 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(v => typeof v !== 'string')) throw new Error('invalid session map'); return Object.assign(Object.create(null), data) } catch (error) { if (error.code === 'ENOENT') return Object.create(null); throw new Error(`Cannot read Aider session map: ${safeMessage(error)}`) } }
async function assertVersion(command) {
  const child = await new Promise((resolveRun, reject) => { const proc = nodeSpawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; proc.stdout.on('data', c => out += c); proc.stderr.on('data', c => out += c); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveRun(out) : reject(new Error(`Could not verify Aider runtime at ${command}`))) })
  if (!new RegExp(`(?:^|\\s)v?${VERSION.replaceAll('.', '\\.')}[\\s$]`).test(child)) throw new Error(`Aider runtime at ${command} must report version ${VERSION}; received ${child.trim().slice(0, 100)}`)
}
function eventQueue() { const values = []; const waiters = []; let ended = false; return { push(value) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : values.push(value) }, finish() { if (ended) return; ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) } } }
function signalProcessTree(child, signal) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch (error) { if (error.code === 'ESRCH') return } } try { child.kill(signal) } catch {} }
function waitForClose(promise, ms) { return new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), ms); promise.then(() => { clearTimeout(timer); resolveWait(true) }, () => { clearTimeout(timer); resolveWait(true) }) }) }
