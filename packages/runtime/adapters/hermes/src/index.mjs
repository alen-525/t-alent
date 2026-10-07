import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.21.3'
const MAX_EVENT_LINE = 4 * 1024 * 1024
const EVENTS = new Set(['session', 'assistant-delta', 'tool-call', 'tool-result', 'complete', 'cancelled', 'error'])
const worker = resolve(fileURLToPath(new URL('../scripts/worker.py', import.meta.url)))

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  validateConfig(config)
  const root = resolve(stateDir)
  const python = resolve(config.python ?? env?.TALENT_PYTHON ?? process.env.TALENT_PYTHON ?? resolve(root, 'hermes-runtime', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'))
  const adjacentSource = resolve(dirname(python), '../..', 'source')
  const source = await access(resolve(adjacentSource, 'run_agent.py')).then(() => adjacentSource, () => resolve(root, 'hermes-runtime', 'source'))
  await verifyRuntime(python, source)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: python, argsPrefix: ['-u'], args: [worker], source, spawnProcess: spawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace || typeof stateDir !== 'string' || !stateDir) throw new TypeError('workspace and stateDir are required')
  validateConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Hermes runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'hermes')
  const host = { ...process.env, ...(env ?? {}) }
  const graceMs = config.cancelGraceMs ?? 4_000
  let active = null
  let disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Hermes package is disposed')
    if (active) throw new Error(`Hermes already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const key = host[profile.apiKeyEnv]
    if (typeof key !== 'string' || !key) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileHash = fingerprint(root, profile)
    const session = String(sessionId || taskId)
    const sessionKey = createHash('sha256').update(`${profileHash}\0${session}`).digest('hex')
    const profileDir = resolve(state, 'profiles', profileHash)
    const request = { taskId, input, workspace: root, profileDir, sessionKey, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl }
    const task = { taskId, request, env: isolatedEnvironment(host, profile, key, profileDir, runtime.source), secrets: collectSecrets(host, key), signal, queue: makeQueue(), child: null, closePromise: null, cancelled: false, completed: false, errorSent: false, settled: false, stderr: '', cancelPromise: null, stopPromise: null }
    active = task
    task.finished = run(task, runtime)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() { try { while (true) { const item = await task.queue.next(); if (item.done) return; yield item.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }

  async function run(task, runtimeInfo) {
    let buffer = ''
    try {
      if (task.signal?.aborted) task.cancelled = true
      if (task.cancelled) return
      await mkdir(task.request.profileDir, { recursive: true, mode: 0o700 })
      if (task.signal?.aborted) task.cancelled = true
      if (task.cancelled) return
      const child = runtimeInfo.spawnProcess(runtimeInfo.command, [...(runtimeInfo.argsPrefix ?? []), ...(runtimeInfo.args ?? [worker])], { cwd: task.request.workspace, env: task.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      task.child = child
      task.queue.push({ type: 'session', sessionId: task.request.sessionKey })
      let spawnError
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { spawnError = error })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, error: spawnError }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (task.cancelled || task.errorSent) return
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (Buffer.byteLength(line) > MAX_EVENT_LINE) { failOutput(task, 'Hermes worker emitted an oversized NDJSON event'); return }
          if (line.trim()) acceptLine(task, line)
        }
        if (Buffer.byteLength(buffer) > MAX_EVENT_LINE) failOutput(task, 'Hermes worker emitted an oversized NDJSON event')
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { task.stderr = (task.stderr + String(chunk)).slice(-16_000) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(task.request) + '\n')
      const outcome = await task.closePromise
      if (buffer.trim() && !task.cancelled) acceptLine(task, buffer)
      if (task.cancelled || task.signal?.aborted) return
      if (outcome.error?.code === 'ENOENT') throw new Error(`Hermes Python runtime was not found at ${runtimeInfo.command}; run the setup:runtime script.`)
      if (outcome.code !== 0) {
        if (!task.errorSent) throw new Error(`Hermes worker exited with ${outcome.signal ?? `code ${outcome.code}`}${task.stderr ? `: ${redact(task.stderr.slice(-4000), task.secrets)}` : ''}`)
        return
      }
      if (!task.completed && !task.errorSent && !task.cancelledEvent) throw new Error('Hermes worker exited without completion')
      if (task.completed && !task.errorSent) task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) await stopChild(task.child, task.closePromise, graceMs)
      if (!task.cancelled && !task.signal?.aborted && !task.errorSent) { task.errorSent = true; task.queue.push({ type: 'error', message: redact(error instanceof Error ? error.message : String(error), task.secrets) }) }
    } finally {
      task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelled && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  function acceptLine(task, line) {
    if (task.cancelled || task.errorSent) return
    let event
    try { event = JSON.parse(line) } catch { return failOutput(task, `Hermes worker emitted malformed NDJSON: ${redact(line.slice(0, 300), task.secrets)}`) }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !EVENTS.has(event.type)) return failOutput(task, 'Hermes worker emitted an unknown or malformed event')
    event = redactDeep(event, task.secrets)
    if (event.type === 'error') { task.errorSent = true; task.queue.push({ type: 'error', message: typeof event.message === 'string' ? event.message : 'Hermes failed' }); return }
    if (event.type === 'complete') { task.completed = true; return }
    if (event.type === 'cancelled') { task.cancelledEvent = true; return }
    if (event.type === 'session' && typeof event.sessionId !== 'string') return failOutput(task, 'Hermes worker emitted malformed session event')
    if (event.type === 'assistant-delta' && typeof event.text !== 'string') return failOutput(task, 'Hermes worker emitted malformed assistant event')
    if (event.type === 'tool-call' && (typeof event.name !== 'string' || typeof event.input !== 'string')) return failOutput(task, 'Hermes worker emitted malformed tool call')
    if (event.type === 'tool-result' && (typeof event.name !== 'string' || typeof event.output !== 'string')) return failOutput(task, 'Hermes worker emitted malformed tool result')
    task.queue.push(event)
  }

  function failOutput(task, message) { if (task.errorSent) return; task.errorSent = true; task.queue.push({ type: 'error', message }); if (task.child) task.stopPromise ??= stopChild(task.child, task.closePromise, graceMs) }
  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelled = true
      if (task.child && !task.closed) {
        killTree(task.child, 'SIGINT')
        if (!await waitForClose(task.closePromise, graceMs)) { killTree(task.child, 'SIGKILL'); await task.closePromise }
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
  const allowed = new Set(['id', 'name', 'provider', 'model', 'protocol', 'apiKeyEnv', 'baseUrl'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('model profile contains unsupported fields')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (value.protocol !== 'openai-chat-completions') throw new TypeError('Hermes supports only openai-chat-completions profiles')
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim())) throw new TypeError('model profile name must be a non-empty string when provided')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || value.model.length > 512 || /[\r\n]/.test(value.model)) throw new TypeError('model or apiKeyEnv is invalid')
  let url
  try { url = new URL(value.baseUrl ?? 'https://api.openai.com/v1') } catch { throw new TypeError('baseUrl must be a valid HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment')
  return { id: value.id.trim(), ...(value.name === undefined ? {} : { name: value.name.trim() }), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), baseUrl: url.href.replace(/\/$/, '') }
}
function validateConfig(config) {
  const allowed = new Set(['python', 'cancelGraceMs'])
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new TypeError(`unsupported Hermes config field: ${key}`)
  if (config.python !== undefined && (typeof config.python !== 'string' || !config.python.trim())) throw new TypeError('python must be a non-empty executable path')
  if (config.cancelGraceMs !== undefined && (!Number.isSafeInteger(config.cancelGraceMs) || config.cancelGraceMs < 1 || config.cancelGraceMs > 60_000)) throw new TypeError('cancelGraceMs must be an integer from 1 to 60000')
}
function fingerprint(workspace, profile) { const { name: _name, ...routing } = profile; return createHash('sha256').update(JSON.stringify({ workspace, profile: routing })).digest('hex') }
function isolatedEnvironment(host, profile, key, profileDir, source) {
  const child = { ...host }
  for (const [name, value] of Object.entries(child)) if (value === key || /^(?:OPENAI|ANTHROPIC|LITELLM|GOOGLE|HERMES|TALENT)_/i.test(name) || /API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API_BASE|BASE_URL|ENDPOINT/i.test(name) || /^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|VIRTUAL_ENV)$/i.test(name)) delete child[name]
  child.TALENT_HERMES_API_KEY = key
  child.TALENT_HERMES_SOURCE = source
  child.HOME = resolve(profileDir, 'home')
  child.HERMES_HOME = resolve(profileDir, 'hermes-home')
  child.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  child.XDG_CACHE_HOME = resolve(profileDir, 'xdg-cache')
  child.XDG_DATA_HOME = resolve(profileDir, 'xdg-data')
  child.BROWSER = '/usr/bin/true'
  child.NO_COLOR = '1'
  child.PYTHONNOUSERSITE = '1'
  child.HERMES_TELEMETRY = 'false'
  return child
}
function collectSecrets(env, key) { return [...new Set([key, ...Object.entries(env).filter(([name, value]) => /API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)].filter(value => typeof value === 'string' && value.length > 0))] }
function redact(text, secrets) { return secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), String(text)) }
function redactDeep(value, secrets) { if (typeof value === 'string') return redact(value, secrets); if (Array.isArray(value)) return value.map(v => redactDeep(v, secrets)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])); return value }
async function verifyRuntime(python, source) {
  const clean = { ...process.env }
  for (const [name, value] of Object.entries(clean)) if (value === process.env.TALENT_HERMES_API_KEY || /^(?:OPENAI|ANTHROPIC|LITELLM|GOOGLE|HERMES|TALENT)_/i.test(name) || /API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|API_BASE|BASE_URL|ENDPOINT/i.test(name)) delete clean[name]
  const proc = spawn(python, ['-c', 'import pathlib,sys,tomllib; p=pathlib.Path(sys.argv[1]); assert tomllib.loads((p/"pyproject.toml").read_text())["project"]["version"] == "0.21.3"; sys.path.insert(0,str(p)); import run_agent; from run_agent import AIAgent; print("0.21.3")', source], { shell: false, env: { ...clean, BROWSER: '/usr/bin/true', HOME: resolve(source, '..', 'verify-home'), HERMES_HOME: resolve(source, '..', 'verify-hermes-home'), TALENT_HERMES_SOURCE: source, PYTHONPATH: source, PYTHONNOUSERSITE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  await new Promise((done, reject) => { proc.stdout.on('data', chunk => output += chunk); proc.stderr.on('data', chunk => output += chunk); proc.once('error', reject); proc.once('close', code => code === 0 ? done() : reject(new Error(`Could not load pinned Hermes runtime at ${python}: ${output.slice(-1200)}`))) })
  if (output.trim().split(/\s+/).at(-1) !== VERSION) throw new Error(`Hermes runtime must be ${VERSION}; received ${output.trim()}`)
}
function makeQueue() { const items = []; const waiters = []; let done = false; return { push(value) { if (done) return; const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : items.push(value) }, finish() { if (done) return; done = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) }, next() { if (items.length) return Promise.resolve({ value: items.shift(), done: false }); if (done) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) } } }
function killTree(child, signal) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return } catch (error) { if (error.code === 'ESRCH') return } } try { child.kill(signal) } catch {} }
function waitForClose(promise, ms) { return new Promise(done => { const timer = setTimeout(() => done(false), ms); promise.then(() => { clearTimeout(timer); done(true) }, () => { clearTimeout(timer); done(true) }) }) }
async function stopChild(child, closePromise, graceMs) { if (!child || !closePromise) { if (child) killTree(child); return }; killTree(child, 'SIGTERM'); if (!await waitForClose(closePromise, graceMs)) { killTree(child, 'SIGKILL'); await closePromise } }
