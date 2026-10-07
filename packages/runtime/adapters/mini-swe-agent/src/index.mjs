import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const VERSION = '2.4.6'
export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  const state = resolve(stateDir, 'mini-swe-agent-runtime')
  const python = config.python ?? env?.TALENT_MINI_SWE_PYTHON ?? process.env.TALENT_MINI_SWE_PYTHON ?? (process.platform === 'win32' ? resolve(state, 'venv', 'Scripts', 'python.exe') : resolve(state, 'venv', 'bin', 'python'))
  await assertVersion(python)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: python, argsPrefix: ['-u', resolve(packageDir, 'worker.py')], spawnProcess: spawn })
}

/** Process seam for adapter tests. Production delegates to the pinned Python package. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  rejectConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Python runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'mini-swe-agent')
  const hostEnv = { ...process.env, ...(env ?? {}) }
  const graceMs = Number.isSafeInteger(config.cancelGraceMs) && config.cancelGraceMs > 0 ? Math.min(config.cancelGraceMs, 60_000) : 5_000
  let active = null
  let disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('mini-SWE-agent package is disposed')
    if (active) throw new Error(`mini-SWE-agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = hostEnv[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileId = fingerprint(profile)
    const hostSession = String(sessionId || taskId)
    const conversationKey = createHash('sha256').update(`${hostSession}\0${profileId}`).digest('hex')
    const profileDir = resolve(state, 'profiles', profileId)
    const taskDir = resolve(profileDir, conversationKey)
    const taskEnv = isolatedEnvironment(hostEnv, profileDir, profile.apiKeyEnv)
    const secrets = findSecrets(hostEnv, apiKey)
    const request = {
      taskId, input, workspace: root, stateDir: taskDir,
      historyPath: resolve(taskDir, 'history.json'), trajectoryPath: resolve(taskDir, 'trajectory.json'),
      hostSessionKey: conversationKey.slice(0, 32), model: profile, apiKey,
      ...(config.commandTimeoutSeconds !== undefined ? { commandTimeoutSeconds: validBound(config.commandTimeoutSeconds, 'commandTimeoutSeconds', 1, 3600) } : {}),
      ...(config.stepLimit !== undefined ? { stepLimit: validBound(config.stepLimit, 'stepLimit', 0, 10000) } : {}),
      ...(config.costLimit !== undefined ? { costLimit: validCost(config.costLimit) } : {}),
    }
    const task = { taskId, request, taskEnv, secrets, signal, queue: eventQueue(), child: null, closePromise: null, cancelled: false, settled: false, abortListener: null, cancelPromise: null, finished: null, stderr: '', stdout: '' }
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
      task.closePromise = new Promise(resolveClose => { child.once('error', error => { task.spawnError = error }); child.once('close', (code, signal) => resolveClose({ code, signal })) })
      child.stdin.on('error', () => {})
      child.stdin.end(`${JSON.stringify(task.request)}\n`)
      let stdoutBuffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdoutBuffer += chunk
        let index
        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index); stdoutBuffer = stdoutBuffer.slice(index + 1)
          if (line.trim()) acceptLine(task, line)
        }
        if (Buffer.byteLength(stdoutBuffer) > 4 * 1024 * 1024) rejectOutput(task, 'mini-SWE-agent worker emitted an oversized NDJSON event')
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { task.stderr = (task.stderr + chunk).slice(-32_000) })
      const outcome = await task.closePromise
      if (stdoutBuffer.trim()) acceptLine(task, stdoutBuffer)
      if (task.cancelled || task.signal?.aborted) return
      if (task.spawnError) throw task.spawnError
      if (outcome.code !== 0 && !task.errorSent) throw new Error(task.stderr.trim() || `mini-SWE-agent worker exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`}`)
      if (!task.completed && !task.errorSent) throw new Error('mini-SWE-agent worker exited without successful completion')
      if (outcome.code === 0 && task.completed && !task.errorSent) task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (!task.cancelled && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(error?.message || String(error), task.secrets) })
    } finally {
      if (task.child && task.child.exitCode === null && task.child.signalCode === null) await stopChild(task)
      task.abortListener && task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelled && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  function acceptLine(task, line) {
    if (task.cancelled || task.errorSent) return
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) return rejectOutput(task, 'mini-SWE-agent worker emitted an oversized NDJSON event')
    let event
    try { event = JSON.parse(line) } catch { return rejectOutput(task, 'mini-SWE-agent worker emitted malformed NDJSON') }
    if (!event || !['session','tool-call','tool-result','assistant-replace','assistant-delta','assistant-complete','error','cancelled'].includes(event.type)) return rejectOutput(task, 'mini-SWE-agent worker emitted an unknown event')
    const safe = redact(event, task.secrets)
    if (safe.type === 'assistant-complete') { task.completed = true; return }
    if (safe.type === 'error') task.errorSent = true
    if (safe.type === 'cancelled') task.cancelEventSent = true
    task.queue.push(safe)
  }

  function rejectOutput(task, message) {
    if (task.errorSent) return
    task.errorSent = true; task.queue.push({ type: 'error', message })
    void stopChild(task)
  }
  async function stopChild(task) {
    if (!task.child || task.child.exitCode !== null || task.child.signalCode !== null) return
    task.stopPromise ??= (async () => {
      try { task.child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGUSR1') } catch {}
      if (!await waitForClose(task.closePromise, graceMs)) { killTree(task.child, 'SIGKILL'); await task.closePromise }
    })()
    await task.stopPromise
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelled = true
      const child = task.child
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGUSR1') } catch {}
        const closed = await waitForClose(task.closePromise, graceMs)
        if (!closed) { killTree(child, 'SIGKILL'); await task.closePromise }
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
  if (value.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${value.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || value.model.length > 512 || /[\r\n]/.test(value.model)) throw new TypeError('model profile model or apiKeyEnv is invalid')
  let url
  try { url = new URL(value.baseUrl ?? 'https://api.openai.com/v1') } catch { throw new TypeError('model profile baseUrl must be a valid HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL without query or fragment')
  return { id: value.id.trim(), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), baseUrl: url.href.replace(/\/$/, '') }
}

function rejectConfig(config) { for (const key of Object.keys(config)) if (!['python','cancelGraceMs','commandTimeoutSeconds','stepLimit','costLimit'].includes(key)) throw new TypeError(`${key} must come from the external model profile or be a supported behavior setting`) }
function fingerprint(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex') }
function validBound(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`config.${name} must be an integer between ${min} and ${max}`); return value }
function validCost(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw new TypeError('config.costLimit must be a number between 0 and 1000'); return value }
function isolatedEnvironment(host, profileDir, apiKeyEnv) {
  const child = { ...host }
  for (const key of Object.keys(child)) if (/^(?:OPENAI|ANTHROPIC|MSWEA|LITELLM|TALENT_MINI_SWE)_/i.test(key) || /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || /^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|VIRTUAL_ENV)$/i.test(key)) delete child[key]
  delete child[apiKeyEnv]
  child.HOME = resolve(profileDir, 'home')
  child.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  child.XDG_CACHE_HOME = resolve(profileDir, 'xdg-cache')
  child.XDG_DATA_HOME = resolve(profileDir, 'xdg-data')
  child.MSWEA_GLOBAL_CONFIG_DIR = resolve(profileDir, 'global-config')
  child.MSWEA_SILENT_STARTUP = '1'
  child.PYTHONNOUSERSITE = '1'
  child.PYTHONUNBUFFERED = '1'
  child.NO_COLOR = '1'
  return child
}
function findSecrets(env, key) {
  const candidates = [key, ...Object.entries(env).filter(([name, value]) => /API_KEY|_KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)]
  return [...new Set(candidates.filter(value => value.length >= 4))]
}
function redact(value, secrets) { if (typeof value === 'string') return secrets.reduce((v, secret) => v.replaceAll(secret, '[redacted]'), value); if (Array.isArray(value)) return value.map(v => redact(v, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redact(v, secrets)])) }
function eventQueue() { const items = [], waiters = []; let ended = false; return { push(item) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ value: item, done: false }) : items.push(item) }, finish() { if (ended) return; ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, next() { if (items.length) return Promise.resolve({ value: items.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) } } }
function waitForClose(promise, ms) { return new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), ms); promise.then(() => { clearTimeout(timer); resolveWait(true) }, () => { clearTimeout(timer); resolveWait(true) }) }) }
function killTree(child, signal) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch {} } try { child.kill(signal) } catch {} }
async function assertVersion(python) {
  const child = await new Promise((resolveRun, reject) => { const proc = spawn(python, ['-c', 'import importlib.metadata,sys; print(importlib.metadata.version("mini-swe-agent")); print(".".join(map(str,sys.version_info[:3])))'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }); let out = ''; proc.stdout.on('data', chunk => out += chunk); proc.stderr.on('data', chunk => out += chunk); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveRun(out) : reject(new Error(`mini-SWE-agent runtime not found at ${python}; run setup:runtime for a private Python >=3.10 runtime`))) })
  const [version, pythonVersion] = child.trim().split(/\r?\n/)
  if (version !== VERSION || !pythonVersion) throw new Error(`Expected mini-swe-agent ${VERSION}; received ${version} on Python ${pythonVersion}`)
}
