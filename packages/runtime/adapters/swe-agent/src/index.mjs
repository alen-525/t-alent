import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const agentVersion = '1.1.0'
const rexVersion = '1.4.0'
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024
const CONFIG_KEYS = new Set(['python', 'cancelGraceMs', 'stepLimit', 'costLimit'])

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  const state = resolve(stateDir, 'swe-agent-runtime')
  const python = config.python ?? env?.TALENT_PYTHON ?? process.env.TALENT_PYTHON ?? resolve(state, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const sourceDir = resolve(dirname(python), '../../source')
  await assertVersion(python, sourceDir)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, {
    command: python,
    argsPrefix: ['-u', resolve(packageDir, 'worker.py')],
    sourceDir,
    spawnProcess: spawn,
  })
}

/** Isolated process seam used by adapter boundary tests. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  rejectConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Python runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'swe-agent-runtime')
  const sourceDir = runtime.sourceDir ?? resolve(state, 'source')
  const hostEnv = { ...process.env, ...(env ?? {}) }
  const graceMs = config.cancelGraceMs ?? 5_000
  let active = null
  let disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('SWE-agent package is disposed')
    if (active) throw new Error(`SWE-agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = hostEnv[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileId = fingerprint(profile)
    const hostSession = String(sessionId || taskId)
    const conversationKey = createHash('sha256').update(`${root}\0${hostSession}\0${profileId}`).digest('hex')
    const profileDir = resolve(state, 'profiles', profileId)
    const taskDir = resolve(profileDir, conversationKey)
    const taskEnv = isolatedEnvironment(hostEnv, profileDir, profile.apiKeyEnv, sourceDir)
    const secrets = findSecrets(hostEnv, apiKey)
    const request = {
      taskId, input, workspace: root, stateDir: taskDir, sourceDir,
      defaultConfigPath: resolve(sourceDir, 'config/default.yaml'),
      historyPath: resolve(taskDir, 'history.json'),
      hostSessionKey: conversationKey.slice(0, 32), model: profile, apiKey,
      ...(config.stepLimit !== undefined ? { stepLimit: bound(config.stepLimit, 'stepLimit', 0, 10000) } : {}),
      ...(config.costLimit !== undefined ? { costLimit: cost(config.costLimit) } : {}),
    }
    const task = { taskId, request, taskEnv, secrets, signal, queue: eventQueue(), child: null, closePromise: null, cancelled: false, settled: false, abortListener: null, cancelPromise: null, finished: null, stderr: '', errorSent: false, completeSeen: false, protocolFailed: false }
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
        cwd: task.request.workspace, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      task.child = child
      let resolveClose
      task.closePromise = new Promise(resolvePromise => { resolveClose = resolvePromise })
      let closeResolved = false
      const close = outcome => { if (!closeResolved) { closeResolved = true; resolveClose(outcome) } }
      child.once('close', (code, signal) => close({ code, signal }))
      child.once('error', error => {
        protocolFailure(task, `SWE-agent worker could not run: ${error?.message || String(error)}`)
        if (child.pid) killTree(child, 'SIGKILL')
        else close({ code: -1, signal: null, error })
      })
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (task.cancelled || task.signal?.aborted || task.protocolFailed) return
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_LINE_BYTES && !buffer.includes('\n')) {
          protocolFailure(task, `SWE-agent worker NDJSON line exceeds ${MAX_EVENT_LINE_BYTES} bytes`)
          return
        }
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
            protocolFailure(task, `SWE-agent worker NDJSON line exceeds ${MAX_EVENT_LINE_BYTES} bytes`)
            buffer = ''
            return
          }
          if (line.trim()) acceptLine(task, line)
          if (task.protocolFailed) { buffer = ''; return }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { task.stderr = (task.stderr + chunk).slice(-32_000) })
      child.stdin.on('error', error => protocolFailure(task, `SWE-agent worker input failed: ${error?.message || String(error)}`))
      child.stdin.end(`${JSON.stringify(task.request)}\n`)
      const outcome = await task.closePromise
      if (!task.protocolFailed && !task.cancelled && !task.signal?.aborted && buffer.trim()) {
        if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_LINE_BYTES) protocolFailure(task, `SWE-agent worker NDJSON line exceeds ${MAX_EVENT_LINE_BYTES} bytes`)
        else acceptLine(task, buffer)
      }
      if (task.cancelled || task.signal?.aborted) return
      if (!task.protocolFailed && outcome.code !== 0) protocolFailure(task, redact(task.stderr.trim() || `SWE-agent worker exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`}`, task.secrets))
      else if (!task.protocolFailed && !task.errorSent && !task.completeSeen) protocolFailure(task, 'SWE-agent worker exited without an assistant-complete event')
      else if (!task.protocolFailed && !task.errorSent && task.completeSeen) task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (!task.cancelled && !task.signal?.aborted) protocolFailure(task, redact(error?.message || String(error), task.secrets))
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
    if (task.completeSeen || task.errorSent) { protocolFailure(task, 'SWE-agent worker emitted an event after a terminal event'); return }
    let event
    try { event = JSON.parse(line) } catch { protocolFailure(task, 'SWE-agent worker emitted malformed NDJSON'); return }
    const invalid = validateEvent(event)
    if (invalid) { protocolFailure(task, invalid); return }
    const safe = redact(event, task.secrets)
    if (safe.type === 'assistant-complete') {
      if (task.completeSeen || task.errorSent) { protocolFailure(task, 'SWE-agent worker emitted an invalid terminal event sequence'); return }
      task.completeSeen = true
      return
    }
    if (safe.type === 'error') task.errorSent = true
    if (safe.type === 'cancelled') task.cancelEventSent = true
    task.queue.push(safe)
  }

  function protocolFailure(task, message) {
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
function rejectConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object')
  for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) throw new TypeError(`unsupported config key: ${key}`)
  if (config.python !== undefined && (typeof config.python !== 'string' || !config.python.trim())) throw new TypeError('config.python must be a non-empty executable path')
  if (config.cancelGraceMs !== undefined) bound(config.cancelGraceMs, 'cancelGraceMs', 1, 60_000)
  if (config.stepLimit !== undefined) bound(config.stepLimit, 'stepLimit', 0, 10_000)
  if (config.costLimit !== undefined) cost(config.costLimit)
}
function fingerprint(profile) { const { ...identity } = profile; return createHash('sha256').update(JSON.stringify(identity)).digest('hex') }
function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return 'SWE-agent worker emitted an invalid event object'
  const schemas = {
    session: ['sessionId'], 'tool-call': ['name', 'callId', 'input'], 'tool-result': ['name', 'callId', 'output', 'status'],
    'assistant-delta': ['text'], 'assistant-replace': ['text'], 'assistant-complete': [], cancelled: [], error: ['message'],
  }
  const fields = schemas[event.type]
  if (!fields) return `SWE-agent worker emitted unsupported event type: ${event.type}`
  const allowed = new Set(['type', ...fields])
  if (Object.keys(event).some(key => !allowed.has(key)) || fields.some(key => typeof event[key] !== 'string')) return `SWE-agent worker emitted invalid ${event.type} event fields`
  return null
}
function bound(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`config.${name} must be an integer between ${min} and ${max}`); return value }
function cost(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw new TypeError('config.costLimit must be a number between 0 and 1000'); return value }
function isolatedEnvironment(host, profileDir, apiKeyEnv, sourceDir) {
  const child = { ...host }
  for (const key of Object.keys(child)) if (/^(?:OPENAI|ANTHROPIC|MSWEA|LITELLM|SWE_AGENT|TALENT_SWE_AGENT)_/i.test(key) || /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || /^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|VIRTUAL_ENV)$/i.test(key)) delete child[key]
  delete child[apiKeyEnv]
  child.HOME = resolve(profileDir, 'home')
  child.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  child.XDG_CACHE_HOME = resolve(profileDir, 'xdg-cache')
  child.XDG_DATA_HOME = resolve(profileDir, 'xdg-data')
  child.PYTHONNOUSERSITE = '1'
  child.PYTHONUNBUFFERED = '1'
  child.NO_COLOR = '1'
  child.SWE_AGENT_CONFIG_ROOT = sourceDir
  child.SWE_AGENT_CONFIG_DIR = resolve(sourceDir, 'config')
  child.SWE_AGENT_TOOLS_DIR = resolve(sourceDir, 'tools')
  child.SWE_AGENT_TRAJECTORY_DIR = resolve(profileDir, 'trajectories')
  child.BROWSER = '/usr/bin/true'
  return child
}
function findSecrets(env, key) { const values = [key, ...Object.entries(env).filter(([name, value]) => /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)]; return [...new Set(values.filter(value => value.length >= 4))] }
function redact(value, secrets) { if (typeof value === 'string') return secrets.reduce((v, secret) => v.replaceAll(secret, '[redacted]'), value); if (Array.isArray(value)) return value.map(v => redact(v, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v, secrets)])) }
function eventQueue() { const items = [], waiters = []; let ended = false; return { push(item) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ value: item, done: false }) : items.push(item) }, finish() { if (ended) return; ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, next() { if (items.length) return Promise.resolve({ value: items.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) } } }
function waitForClose(promise, ms) { return new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), ms); promise.then(() => { clearTimeout(timer); resolveWait(true) }, () => { clearTimeout(timer); resolveWait(true) }) }) }
function killTree(child, signal) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch {} } try { child.kill(signal) } catch {} }
async function assertVersion(python, sourceDir) {
  const result = await new Promise((resolveRun, reject) => {
    const env = { ...process.env, SWE_AGENT_CONFIG_ROOT: sourceDir, SWE_AGENT_CONFIG_DIR: resolve(sourceDir, 'config'), SWE_AGENT_TOOLS_DIR: resolve(sourceDir, 'tools'), SWE_AGENT_TRAJECTORY_DIR: resolve(sourceDir, 'trajectories') }
    const proc = spawn(python, ['-c', 'import importlib.metadata as m,sys; print(m.version("sweagent")); print(m.version("swe-rex")); print(".".join(map(str,sys.version_info[:3])))'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env })
    let output = ''; proc.stdout.on('data', chunk => output += chunk); proc.stderr.on('data', chunk => output += chunk); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`SWE-agent runtime missing at ${python}; run setup:runtime using Python >=3.11`)))
  })
  const [agentVersion_, rexVersion_, pythonVersion] = result.trim().split(/\r?\n/)
  if (agentVersion_ !== agentVersion || rexVersion_ !== rexVersion || !pythonVersion) throw new Error(`Expected sweagent ${agentVersion} + swe-rex ${rexVersion}; received ${agentVersion_} + ${rexVersion_} on Python ${pythonVersion}`)
}
