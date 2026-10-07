import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const runtimeVersion = '1.26.0'
const MAX_LINE_BYTES = 4 * 1024 * 1024
const CONFIG_KEYS = new Set(['python', 'maxSteps', 'cancelGraceMs'])

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  validateConfig(config)
  const runtimeRoot = resolve(stateDir, 'smolagents-runtime')
  const python = config.python ?? env?.TALENT_SMOLAGENTS_PYTHON ?? process.env.TALENT_SMOLAGENTS_PYTHON ?? env?.TALENT_PYTHON ?? process.env.TALENT_PYTHON ?? resolve(runtimeRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  await assertRuntime(python)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, {
    command: python, argsPrefix: ['-u', resolve(packageDir, 'worker.py')], spawnProcess: spawn,
  })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  validateConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Python runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'smolagents-runtime')
  const hostEnv = { ...process.env, ...(env ?? {}) }
  const graceMs = config.cancelGraceMs ?? 5000
  let active = null
  let disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('smolagents package is disposed')
    if (active) throw new Error(`smolagents package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = hostEnv[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileId = digest(JSON.stringify(profile))
    const hostSession = String(sessionId || taskId)
    const scope = digest(`${root}\0${hostSession}\0${profileId}`)
    const profileDir = resolve(state, 'profiles', profileId)
    const taskDir = resolve(profileDir, scope)
    const childEnv = isolatedEnvironment(hostEnv, profileDir, apiKey)
    const secrets = [...new Set([apiKey, ...findSecrets(hostEnv)])]
    const request = {
      taskId, input, workspace: root, stateDir: taskDir,
      historyPath: resolve(taskDir, 'history.json'),
      hostSessionKey: scope.slice(0, 32),
      model: { id: profile.id, provider: profile.provider, model: profile.model, protocol: profile.protocol, baseUrl: profile.baseUrl },
      ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
    }
    const task = {
      taskId, request, childEnv, secrets, signal, queue: createQueue(), child: null, closePromise: null,
      finished: null, cancelled: false, settled: false, errorSent: false, completeSeen: false, protocolFailed: false,
      abortListener: null, cancelPromise: null, stderr: '', cancelEventSent: false,
    }
    active = task
    task.finished = run(task, runtime)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() {
      try { while (true) { const next = await task.queue.next(); if (next.done) return; yield next.value } }
      finally { if (!task.settled) await cancelTask(taskId) }
    } }
  }

  async function run(task, runtime) {
    try {
      await mkdir(task.request.stateDir, { recursive: true, mode: 0o700 })
      if (task.cancelled || task.signal?.aborted) return
      const child = runtime.spawnProcess(runtime.command, [...(runtime.argsPrefix ?? []), ...(runtime.args ?? [])], {
        cwd: task.request.workspace, env: task.childEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      task.child = child
      let resolveClose
      task.closePromise = new Promise(resolvePromise => { resolveClose = resolvePromise })
      let closed = false
      const close = outcome => { if (!closed) { closed = true; resolveClose(outcome) } }
      child.once('close', (code, signal) => close({ code, signal }))
      child.once('error', error => {
        fail(task, `smolagents worker could not run: ${error?.message || String(error)}`)
        if (child.pid) killTree(child, 'SIGKILL')
        else close({ code: -1, signal: null, error })
      })
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (task.cancelled || task.signal?.aborted || task.protocolFailed) return
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { fail(task, `smolagents worker NDJSON line exceeds ${MAX_LINE_BYTES} bytes`); buffer = ''; return }
          if (line.trim()) acceptLine(task, line)
          if (task.protocolFailed) { buffer = ''; return }
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) { fail(task, `smolagents worker NDJSON line exceeds ${MAX_LINE_BYTES} bytes`); buffer = '' }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { task.stderr = (task.stderr + chunk).slice(-32_000) })
      child.stdin.on('error', error => fail(task, `smolagents worker input failed: ${error?.message || String(error)}`))
      child.stdin.end(`${JSON.stringify(task.request)}\n`)
      const outcome = await task.closePromise
      if (!task.protocolFailed && !task.cancelled && !task.signal?.aborted && buffer.trim()) {
        if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) fail(task, `smolagents worker NDJSON line exceeds ${MAX_LINE_BYTES} bytes`)
        else acceptLine(task, buffer)
      }
      if (task.cancelled || task.signal?.aborted) return
      if (!task.protocolFailed && outcome.code !== 0) fail(task, redact(task.stderr.trim() || `smolagents worker exited with code ${outcome.code}`, task.secrets))
      else if (!task.protocolFailed && !task.errorSent && !task.completeSeen) fail(task, 'smolagents worker exited without an assistant-complete event')
      else if (!task.protocolFailed && !task.errorSent && task.completeSeen) task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (!task.cancelled && !task.signal?.aborted) fail(task, redact(error?.message || String(error), task.secrets))
    } finally {
      task.abortListener && task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelled && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  function acceptLine(task, line) {
    if (task.cancelled || task.signal?.aborted || task.protocolFailed) return
    if (task.completeSeen || task.errorSent) { fail(task, 'smolagents worker emitted an event after a terminal event'); return }
    let event
    try { event = JSON.parse(line) } catch { fail(task, 'smolagents worker emitted malformed NDJSON'); return }
    const message = validateEvent(event)
    if (message) { fail(task, message); return }
    const safe = redact(event, task.secrets)
    if (safe.type === 'assistant-complete') { task.completeSeen = true; return }
    if (safe.type === 'error') task.errorSent = true
    if (safe.type === 'cancelled') task.cancelEventSent = true
    task.queue.push(safe)
  }

  function fail(task, message) {
    if (task.protocolFailed || task.cancelled || task.signal?.aborted) return
    task.protocolFailed = true
    if (!task.errorSent) { task.errorSent = true; task.queue.push({ type: 'error', message: redact(message, task.secrets) }) }
    const child = task.child
    if (child && child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL')
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelled = true
      const child = task.child
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGUSR1') } catch {}
        if (!await waitForClose(task.closePromise, graceMs)) { killTree(child, 'SIGKILL'); await task.closePromise }
      }
      await task.finished
    })()
    await task.cancelPromise
  }

  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (value.name !== undefined && typeof value.name !== 'string') throw new TypeError('model profile name must be a string when provided')
  if (value.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${value.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || /[\r\n]/.test(value.model)) throw new TypeError('model profile model or apiKeyEnv is invalid')
  const baseUrl = value.baseUrl ?? 'https://api.openai.com/v1'
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new TypeError('model profile baseUrl must be a non-empty URL when provided')
  let url
  try { url = new URL(baseUrl) } catch { throw new TypeError('model profile baseUrl must be a valid HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL without query or fragment')
  return { id: value.id.trim(), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), baseUrl: baseUrl.replace(/\/$/, '') }
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object')
  for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) throw new TypeError(`unsupported config key: ${key}`)
  if (config.python !== undefined && (typeof config.python !== 'string' || !config.python.trim())) throw new TypeError('config.python must be a non-empty executable path')
  if (config.maxSteps !== undefined) bound(config.maxSteps, 'maxSteps', 1, 100)
  if (config.cancelGraceMs !== undefined) bound(config.cancelGraceMs, 'cancelGraceMs', 1, 60_000)
}
function bound(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`config.${name} must be an integer between ${min} and ${max}`); return value }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function isolatedEnvironment(host, profileDir, apiKey) {
  const child = { ...host }
  for (const key of Object.keys(child)) if (child[key] === apiKey || /^(?:OPENAI|ANTHROPIC|LITELLM|SMOLAGENTS|TALENT_SMOLAGENTS)_/i.test(key) || /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || /^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|VIRTUAL_ENV)$/i.test(key)) delete child[key]
  child.TALENT_SMOLAGENTS_API_KEY = apiKey
  child.HOME = resolve(profileDir, 'home')
  child.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  child.XDG_CACHE_HOME = resolve(profileDir, 'xdg-cache')
  child.XDG_DATA_HOME = resolve(profileDir, 'xdg-data')
  child.PYTHONNOUSERSITE = '1'
  child.PYTHONUNBUFFERED = '1'
  child.NO_COLOR = '1'
  child.BROWSER = '/usr/bin/true'
  child.TERMINAL = 'dumb'
  return child
}
function findSecrets(env) { return [...new Set(Object.entries(env).filter(([name, value]) => (/API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) && typeof value === 'string' && value.length >= 4).map(([, value]) => value))] }
function redact(value, secrets) { if (typeof value === 'string') return secrets.reduce((v, secret) => v.replaceAll(secret, '[redacted]'), value); if (Array.isArray(value)) return value.map(v => redact(v, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v, secrets)])) }
function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return 'smolagents worker emitted an invalid event object'
  const schemas = { session: ['sessionId'], 'tool-call': ['name', 'callId', 'input'], 'tool-result': ['name', 'callId', 'output', 'status'], 'assistant-replace': ['text'], 'assistant-complete': [], cancelled: [], error: ['message'] }
  const fields = schemas[event.type]
  if (!fields) return `smolagents worker emitted unsupported event type: ${event.type}`
  const allowed = new Set(['type', ...fields])
  if (Object.keys(event).some(key => !allowed.has(key)) || fields.some(key => typeof event[key] !== 'string')) return `smolagents worker emitted invalid ${event.type} event fields`
  return null
}
function createQueue() { const items = [], waiters = []; let ended = false; return { push(value) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : items.push(value) }, finish() { if (ended) return; ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, next() { if (items.length) return Promise.resolve({ value: items.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) } } }
function waitForClose(promise, ms) { return new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), ms); promise.then(() => { clearTimeout(timer); resolveWait(true) }, () => { clearTimeout(timer); resolveWait(true) }) }) }
function killTree(child, signal) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch {} } try { child.kill(signal) } catch {} }
async function assertRuntime(python) {
  const output = await new Promise((resolveRun, reject) => {
    const child = spawn(python, ['-c', 'import importlib.metadata as m,sys; import openai; from smolagents import CodeAgent,OpenAIServerModel; print(m.version("smolagents")); print(m.version("openai")); print(".".join(map(str,sys.version_info[:3])))'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: isolatedEnvironment(process.env, resolve(python, '..'), '') })
    let text = ''; child.stdout.on('data', chunk => text += chunk); child.stderr.on('data', chunk => text += chunk)
    child.once('error', reject); child.once('close', code => code === 0 ? resolveRun(text) : reject(new Error(`smolagents runtime missing at ${python}; run setup:runtime with Python >=3.10`)))
  })
  const [version] = output.trim().split(/\r?\n/)
  if (version !== runtimeVersion) throw new Error(`Expected smolagents ${runtimeVersion}, received ${version}`)
}
