import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/worker.py')
const VERSION = '0.7.21'
const WORKER_EVENTS = new Set(['session', 'assistant-delta', 'reasoning', 'tool-call', 'tool-result', 'harness-event', 'complete', 'error'])
const MAX_EVENT_LINE = 4 * 1024 * 1024

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  const state = resolve(stateDir)
  const python = config.python ?? env?.DEEPAGENTS_PYTHON ?? process.env.DEEPAGENTS_PYTHON ?? resolve(state, 'deepagents-runtime', 'venv', 'bin', 'python')
  await verifyRuntime(python)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: python, worker, spawnProcess: nodeSpawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  rejectConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Deep Agents runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir, 'deepagents')
  await mkdir(state, { recursive: true })
  const sessionsPath = resolve(state, 'sessions.json')
  const sessions = await readSessions(sessionsPath)
  const envHost = { ...process.env, ...(env ?? {}) }
  const graceMs = Number.isSafeInteger(config.cancelGraceMs) && config.cancelGraceMs > 0 ? Math.min(config.cancelGraceMs, 60_000) : 5_000
  let active = null
  let disposed = false

  async function persist() {
    const tmp = `${sessionsPath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 })
    await rename(tmp, sessionsPath)
  }
  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Deep Agents package is disposed')
    if (active) throw new Error(`Deep Agents package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = envHost[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileHash = fingerprint(profile)
    const conversation = createHash('sha256').update(`${String(sessionId || taskId)}\0${profileHash}`).digest('hex')
    const profileDir = resolve(state, 'profiles', profileHash)
    const taskEnv = isolatedEnvironment(envHost, profile, apiKey, profileDir)
    const task = { taskId, input, profile, profileHash, conversation, profileDir, taskEnv, secrets: getSecrets(envHost, apiKey), signal, queue: eventQueue(), child: null, closePromise: null, closed: false, childReady: null, signalChildReady: null, cancelled: false, settled: false, cancelPromise: null, errorSent: false }
    task.childReady = new Promise(resolveReady => { task.signalChildReady = resolveReady })
    active = task
    task.finished = run(task)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() { try { while (true) { const item = await task.queue.next(); if (item.done) return; yield item.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }
  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelled = true
      await Promise.race([task.childReady, task.finished])
      if (task.child && !task.closed) {
        signalTree(task.child, 'SIGINT')
        if (!await waitForClose(task.closePromise, graceMs)) { signalTree(task.child, 'SIGKILL'); await task.closePromise }
      }
      await task.finished
    })()
    await task.cancelPromise
  }
  async function run(task) {
    let buffer = ''
    let stderr = ''
    try {
      if (task.signal?.aborted) task.cancelled = true
      if (task.cancelled) return
      await mkdir(task.profileDir, { recursive: true })
      if (task.signal?.aborted) task.cancelled = true
      if (task.cancelled) return
      const database = resolve(task.profileDir, 'checkpoints.sqlite')
      const child = runtime.spawnProcess(runtime.command, [runtime.worker], { cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      task.child = child
      task.queue.push({ type: 'session', sessionId: task.conversation })
      task.signalChildReady()
      let spawnError
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { spawnError = error })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, error: spawnError }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (task.cancelled) return
        buffer += chunk
        if (buffer.length > MAX_EVENT_LINE && !buffer.includes('\n')) {
          task.errorSent = true
          task.queue.push({ type: 'error', message: 'Deep Agents worker emitted an oversized NDJSON event' })
          signalTree(child, 'SIGTERM')
          return
        }
        let offset
        while ((offset = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 1); if (line.length > MAX_EVENT_LINE) { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted an oversized NDJSON event' }); signalTree(child, 'SIGTERM'); return }; acceptEvent(task, line) }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { if (stderr.length < 16_000) stderr += String(chunk).slice(0, 16_000 - stderr.length) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ workspace: root, dbPath: database, threadId: task.conversation, model: task.profile.model, apiKeyEnv: task.profile.apiKeyEnv, baseUrl: task.profile.baseUrl ?? 'https://api.openai.com/v1', input: task.input, systemPrompt: task.profile.systemPrompt ?? 'You are a coding agent. Use the available Deep Agents filesystem tools to inspect and modify the selected workspace. Keep edits focused and report what you changed.' }))
      const outcome = await task.closePromise
      if (buffer.trim() && !task.cancelled) acceptEvent(task, buffer)
      if (task.cancelled || task.signal?.aborted) return
      if (outcome.error?.code === 'ENOENT') throw new Error(`Deep Agents Python runtime was not found at ${runtime.command}; run the setup:runtime script.`)
      if (outcome.code !== 0 && !task.errorSent) throw new Error(`Deep Agents worker exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`}${stderr.trim() ? `: ${redact(stderr.trim().slice(-4000), task.secrets)}` : ''}`)
      if (!task.completed && !task.errorSent) throw new Error(`Deep Agents worker exited without completion${stderr.trim() ? `: ${redact(stderr.trim().slice(-4000), task.secrets)}` : ''}`)
      if (task.completed && !task.errorSent) task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) { signalTree(task.child, 'SIGTERM'); if (!await waitForClose(task.closePromise, graceMs)) signalTree(task.child, 'SIGKILL'); await task.closePromise?.catch(() => {}) }
      if (!task.cancelled && !task.signal?.aborted && !task.errorSent) { task.errorSent = true; task.queue.push({ type: 'error', message: redact(error instanceof Error ? error.message : String(error), task.secrets) }) }
    } finally {
      task.signalChildReady?.()
      task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelled && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      if (!task.cancelled && task.completed && !task.errorSent) { sessions[task.conversation] = task.profileHash; await persist().catch(error => task.queue.push({ type: 'error', message: `Could not persist Deep Agents session: ${error.message}` })) }
      task.queue.finish()
      if (active === task) active = null
    }
  }
  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

function acceptEvent(task, line) {
  if (!line.trim() || task.cancelled) return
  let event
  try { event = JSON.parse(line) } catch { task.errorSent = true; task.queue.push({ type: 'error', message: `Deep Agents worker emitted invalid NDJSON: ${redact(line.slice(0, 500), task.secrets)}` }); return }
  if (!event || typeof event.type !== 'string') { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted a malformed event' }); return }
  if (!WORKER_EVENTS.has(event.type)) { task.errorSent = true; task.queue.push({ type: 'error', message: `Deep Agents worker emitted unsupported event type: ${redact(event.type, task.secrets)}` }); return }
  event = redactDeep(event, task.secrets)
  if (event.type === 'error') { task.errorSent = true; task.queue.push({ type: 'error', message: redact(event.message ?? 'Deep Agents failed', task.secrets) }); return }
  if (event.type === 'complete') { task.completed = true; return }
  if (['assistant-delta', 'reasoning'].includes(event.type) && typeof event.text !== 'string') { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted a malformed assistant event' }); return }
  if (event.type === 'tool-call' && (typeof event.name !== 'string' || !Object.hasOwn(event, 'input'))) { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted a malformed tool call' }); return }
  if (event.type === 'tool-result' && (typeof event.name !== 'string' || !Object.hasOwn(event, 'output'))) { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted a malformed tool result' }); return }
  if (event.type === 'session' && typeof event.sessionId !== 'string') { task.errorSent = true; task.queue.push({ type: 'error', message: 'Deep Agents worker emitted a malformed session event' }); return }
  task.queue.push(event)
}
function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model profile is required')
  const allowed = new Set(['id', 'name', 'provider', 'model', 'protocol', 'apiKeyEnv', 'baseUrl'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError('model profile contains unsupported fields')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (value.protocol !== 'openai-chat-completions') throw new TypeError('Deep Agents adapter supports only the external openai-chat-completions profile')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || /[\r\n]/.test(value.model) || value.model.length > 200) throw new TypeError('model or apiKeyEnv is invalid')
  if (value.baseUrl !== undefined) { const url = new URL(value.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment') }
  return { id: value.id.trim(), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), ...(value.baseUrl ? { baseUrl: value.baseUrl.replace(/\/$/, '') } : {}) }
}
function rejectConfig(config) { const allowed = new Set(['python', 'cancelGraceMs']); for (const key of Object.keys(config)) if (!allowed.has(key)) throw new TypeError(`unsupported Deep Agents config field: ${key}`) }
function fingerprint(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex') }
function isolatedEnvironment(host, profile, key, profileDir) {
  const env = { ...host }
  for (const name of Object.keys(env)) if (/^(OPENAI_|LANGCHAIN_|LANGSMITH_|DEEPAGENTS_|TAVILY_|ANTHROPIC_|GOOGLE_API_KEY)/i.test(name) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_BASE|BASE_URL|ENDPOINT/i.test(name)) delete env[name]
  env.OPENAI_API_KEY = key
  env[profile.apiKeyEnv] = key
  env.OPENAI_BASE_URL = profile.baseUrl ?? 'https://api.openai.com/v1'
  env.DEEPAGENTS_API_KEY_ENV = profile.apiKeyEnv
  env.DEEPAGENTS_STATE_DIR = profileDir
  env.LANGCHAIN_TRACING_V2 = 'false'
  env.LANGSMITH_TRACING = 'false'
  env.HOME = resolve(profileDir, 'home')
  env.XDG_CONFIG_HOME = resolve(profileDir, 'xdg-config')
  env.BROWSER = '/usr/bin/true'
  env.NO_COLOR = '1'
  return env
}
function getSecrets(env, key) { return [...new Set([key, ...Object.entries(env).filter(([n, v]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n) && typeof v === 'string' && v.length >= 4).map(([, v]) => v)].filter(v => v.length >= 4))] }
function redact(value, secrets) { return secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), String(value)) }
function redactDeep(value, secrets) { if (typeof value === 'string') return redact(value, secrets); if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redactDeep(v,secrets)])); return value }
async function readSessions(path) { try { const value = JSON.parse(await readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid session map'); return Object.assign(Object.create(null), value) } catch (error) { if (error.code === 'ENOENT') return Object.create(null); throw new Error(`Cannot read Deep Agents session map: ${error.message}`) } }
async function verifyRuntime(python) {
  const proc = nodeSpawn(python, ['-c', 'import importlib.metadata as m; print("|".join(m.version(p) for p in ["deepagents", "langchain-openai", "langgraph-checkpoint-sqlite"]))'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: '/usr/bin/true' } })
  let output = ''
  await new Promise((resolveDone, reject) => { proc.stdout.on('data', c => output += c); proc.stderr.on('data', c => output += c); proc.once('error', reject); proc.once('close', code => code === 0 ? resolveDone() : reject(new Error(`Could not load pinned Deep Agents SDK at ${python}: ${output.slice(-1000)}`))) })
  if (output.trim() !== `${VERSION}|1.6.7|3.1.1`) throw new Error(`Deep Agents runtime requires ${VERSION}, langchain-openai 1.6.7 and SQLite checkpoints 3.1.1; received ${output.trim()}`)
}
function eventQueue() { const values=[]; const waiters=[]; let ended=false; return { push(value){if(ended)return;const w=waiters.shift();w?w({value,done:false}):values.push(value)},finish(){if(ended)return;ended=true;while(waiters.length)waiters.shift()({value:undefined,done:true})},next(){if(values.length)return Promise.resolve({value:values.shift(),done:false});if(ended)return Promise.resolve({value:undefined,done:true});return new Promise(resolveNext=>waiters.push(resolveNext))} } }
function signalTree(child, signal) { if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,signal);return}catch(error){if(error.code==='ESRCH')return}}try{child.kill(signal)}catch{} }
function waitForClose(promise,ms){return new Promise(done=>{const timer=setTimeout(()=>done(false),ms);promise.then(()=>{clearTimeout(timer);done(true)},()=>{clearTimeout(timer);done(true)})})}
