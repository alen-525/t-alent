import { spawn, execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const EXPECTED_VERSION = '2.25.8'
const ENV_KEY = 'TALENT_MISTRAL_VIBE_MODEL_API_KEY'

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  const parentEnv = { ...process.env, ...(env ?? {}) }
  const python = config.python ?? parentEnv.TALENT_MISTRAL_VIBE_PYTHON ?? resolve(stateDir, config.venvDir ?? (process.platform === 'win32' ? 'mistral-vibe-runtime/venv/Scripts/python.exe' : 'mistral-vibe-runtime/venv/bin/python'))
  const command = config.program ?? resolve(dirname(python), process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp')
  const probeHome = resolve(stateDir, 'version-probe')
  await mkdir(probeHome, { recursive: true, mode: 0o700 })
  const probeEnv = isolateEnvironment(parentEnv, '', probeHome)
  const result = await execFile(command, ['--version'], { env: probeEnv, cwd: probeHome, timeout: 10_000 })
  if (!new RegExp(`^vibe-acp(?:\\.exe)? ${EXPECTED_VERSION.replaceAll('.', '\\.')}$`).test(String(result.stdout).trim())) throw new Error(`Expected Mistral Vibe ${EXPECTED_VERSION}; found ${String(result.stdout).trim()}`)
  return createAgentPackageWithRuntime({ workspace, stateDir, env: parentEnv, config }, { command, spawnProcess: spawn })
}

/** Child process seam for tests; production starts the original Vibe ACP runtime. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  for (const key of Object.keys(config)) if (!['python', 'venvDir', 'program', 'cancelGraceMs'].includes(key)) throw new TypeError(`Unsupported Mistral Vibe config: ${key}; model behavior belongs to the host profile`)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Mistral Vibe runtime command and spawnProcess are required')
  const grace = config.cancelGraceMs ?? 5000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60_000) throw new TypeError('cancelGraceMs must be between 1 and 60000')
  const root = resolve(workspace), state = resolve(stateDir), homes = resolve(state, 'profiles'), sessionsFile = resolve(state, 'sessions.json')
  await mkdir(homes, { recursive: true, mode: 0o700 })
  const sessions = await readSessions(sessionsFile)
  let active = null, disposed = false

  async function persistSessions() {
    const temporary = `${sessionsFile}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(sessions), { mode: 0o600 }); await rename(temporary, sessionsFile)
  }

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Mistral Vibe package is disposed')
    if (active) throw new Error(`Mistral Vibe package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and non-empty input are required')
    const profile = validateProfile(model)
    const hostEnv = { ...process.env, ...(env ?? {}) }
    const credential = hostEnv[profile.apiKeyEnv]
    if (typeof credential !== 'string' || !credential) throw new TypeError(`Model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const profileHash = createHash('sha256').update(routeKey(profile)).digest('hex')
    const sessionKey = createHash('sha256').update(JSON.stringify([root, String(sessionId || taskId), profileHash])).digest('hex')
    const persistedId = sessions[sessionKey]
    const home = resolve(homes, profileHash)
    const taskEnv = isolateEnvironment(hostEnv, credential, home)
    const secrets = collectSecrets(hostEnv, credential)
    const task = {
      taskId, input, profile, profileHash, sessionKey, persistedId, home, taskEnv, secrets, signal,
      queue: eventQueue(), child: null, closed: false, settled: false, cancelling: Boolean(signal?.aborted),
      grace, rpcId: 0, pending: new Map(), line: '', spawnError: null, protocolError: null,
      promptResponse: null, toolNames: new Map(),
    }
    active = task
    task.finished = Promise.resolve().then(() => run(task))
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener(); else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() { try { for (;;) { const next = await task.queue.next(); if (next.done) return; yield next.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }

  async function run(task) {
    try {
      if (task.cancelling || task.signal?.aborted) return
      await mkdir(task.home, { recursive: true, mode: 0o700 })
      await writeFile(resolve(task.home, 'config.toml'), renderConfig(task.profile), { mode: 0o600 })
      if (task.cancelling || task.signal?.aborted) return
      const child = runtime.spawnProcess(runtime.command, runtime.args ?? [], {
        cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      task.child = child
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { task.spawnError = error })
        child.once('close', (code, terminationSignal) => { task.closed = true; for (const pending of task.pending.values()) pending.reject(task.spawnError ?? new Error(`Mistral Vibe ACP exited with code ${code ?? 'unknown'}`)); task.pending.clear(); resolveClose({ code, signal: terminationSignal }) })
      })
      child.stdin.on('error', error => { task.stdinError = error })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => consumeStdout(task, chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { task.stderr = (task.stderr ?? '').slice(-12_000) + String(chunk).slice(-12_000) })

      await rpc(task, 'initialize', { protocolVersion: 1, clientInfo: { name: 'talent', version: '0.2.0' }, clientCapabilities: {} })
      notify(task, 'initialized', {})
      if (task.cancelling || task.signal?.aborted) return
      let session
      if (task.persistedId) {
        try { session = await rpc(task, 'session/load', { cwd: root, sessionId: task.persistedId, mcpServers: [] }) }
        catch (error) {
          if (!/not found|no session|session.*missing/i.test(error.message)) throw error
          delete sessions[task.sessionKey]; task.persistedId = null
        }
      }
      if (!session) session = await rpc(task, 'session/new', { cwd: root, mcpServers: [] })
      const vibeSessionId = session.sessionId ?? task.persistedId
      if (typeof vibeSessionId !== 'string' || !vibeSessionId) throw new Error('Mistral Vibe did not return a session id')
      task.vibeSessionId = vibeSessionId
      sessions[task.sessionKey] = vibeSessionId
      await persistSessions()
      task.queue.push({ type: 'session', sessionId: redact(vibeSessionId, task.secrets) })
      if (task.cancelling || task.signal?.aborted) return
      task.promptResponse = await rpc(task, 'session/prompt', { sessionId: vibeSessionId, prompt: [{ type: 'text', text: task.input }] })
      if (task.promptResponse?.stopReason === 'cancelled') task.cancelling = true
      if (task.cancelling || task.signal?.aborted) return
      if (task.promptResponse?.stopReason !== 'end_turn') throw new Error(`Mistral Vibe prompt ended without success (${task.promptResponse?.stopReason ?? 'missing stopReason'})`)
      task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) await terminate(task)
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(error?.message || String(error), task.secrets) })
    } finally {
      if (task.child?.stdin && !task.closed) { try { task.child.stdin.end() } catch {} }
      task.signal?.removeEventListener('abort', task.abortListener)
      if (task.child && !task.closed) await terminate(task)
      task.settled = true
      if (task.cancelling) task.queue.push({ type: 'cancelled' })
      task.queue.finish()
      if (active === task) active = null
    }
  }

  function consumeStdout(task, chunk) {
    task.line += chunk
    if (Buffer.byteLength(task.line, 'utf8') > 4 * 1024 * 1024 && !task.line.includes('\n')) {
      task.protocolError ??= new Error('Mistral Vibe ACP line exceeded 4 MiB'); void terminate(task); return
    }
    let newline
    while ((newline = task.line.indexOf('\n')) >= 0) {
      const line = task.line.slice(0, newline); task.line = task.line.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) task.protocolError ??= new Error('Mistral Vibe ACP line exceeded 4 MiB')
      else handleMessage(task, line)
      if (task.protocolError) { void terminate(task); return }
    }
    if (Buffer.byteLength(task.line, 'utf8') > 4 * 1024 * 1024) { task.protocolError ??= new Error('Mistral Vibe ACP line exceeded 4 MiB'); void terminate(task) }
  }

  function handleMessage(task, line) {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { task.protocolError ??= new Error('Mistral Vibe emitted malformed ACP JSON'); return }
    if (message?.id !== undefined && task.pending.has(message.id)) {
      const pending = task.pending.get(message.id); task.pending.delete(message.id)
      if (message.error) pending.reject(new Error(redact(message.error.message ?? 'ACP request failed', task.secrets)))
      else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message?.method !== 'string') { task.protocolError ??= new Error('Mistral Vibe emitted an invalid ACP message'); return }
    if (message.method === 'session/update') mapSessionUpdate(task, message.params)
    else if (message.id !== undefined) {
      // The selected Vibe profile is auto-approve; any unsupported client request must fail closed.
      respond(task, message.id, null, { code: -32601, message: `Unsupported Vibe ACP client request: ${message.method}` })
    }
  }

  function mapSessionUpdate(task, params) {
    if (task.cancelling) return
    const update = params?.update
    if (!update || typeof update.sessionUpdate !== 'string') return
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const text = extractText(update.content)
      if (text) task.queue.push({ type: 'assistant-delta', text: redact(text, task.secrets) })
    } else if (kind === 'agent_thought_chunk') {
      const text = extractText(update.content)
      if (text) task.queue.push({ type: 'reasoning', text: redact(text, task.secrets) })
    } else if (kind === 'tool_call') {
      const id = update.toolCallId ?? update.tool_call_id ?? randomUUID(), name = update.title ?? update.name ?? 'tool'
      task.toolNames.set(id, name)
      task.queue.push({ type: 'tool-call', name: redact(name, task.secrets), callId: redact(id, task.secrets), input: redactDeep(update.rawInput ?? {}, task.secrets) })
    } else if (kind === 'tool_call_update') {
      const id = update.toolCallId ?? update.tool_call_id ?? '', name = task.toolNames.get(id) ?? update.title ?? 'tool'
      const status = update.status
      const output = (update.content ?? []).map(extractText).filter(Boolean).join('\n') || (update.rawOutput ?? '')
      if (status === 'completed' || status === 'failed' || status === 'canceled') {
        const error = status !== 'completed'
        task.queue.push({ type: 'tool-result', name: redact(name, task.secrets), callId: redact(id, task.secrets), status: error ? 'error' : 'success', output: redactDeep(output, task.secrets) })
      }
    } else if (kind === 'plan') task.queue.push({ type: 'harness-event', event: redactDeep(update, task.secrets) })
  }

  function rpc(task, method, params) {
    const id = ++task.rpcId
    const promise = new Promise((resolveResponse, rejectResponse) => task.pending.set(id, { resolve: resolveResponse, reject: rejectResponse }))
    if (!write(task, { jsonrpc: '2.0', id, method, params })) {
      task.pending.delete(id); return Promise.reject(task.stdinError ?? new Error('Mistral Vibe ACP stdin is closed'))
    }
    return promise
  }
  function notify(task, method, params) { write(task, { jsonrpc: '2.0', method, params }) }
  function respond(task, id, result, error) { write(task, { jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) }
  function write(task, message) {
    if (!task.child || task.closed || task.stdinError) return false
    try { task.child.stdin.write(`${JSON.stringify(message)}\n`); return true } catch (error) { task.stdinError = error; return false }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      if (task.child && !task.closed) {
        if (task.vibeSessionId) notify(task, 'session/cancel', { sessionId: task.vibeSessionId })
        if (!await waitClose(task.closePromise, grace)) await terminate(task)
      }
      await task.finished
    })()
    await task.cancelPromise
  }
  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof profile[key] !== 'string' || !profile[key].trim() || profile[key].length > 512) throw new TypeError(`model profile ${key} is required and must be at most 512 characters`)
  if (profile.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${profile.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) throw new TypeError('model profile apiKeyEnv must be a valid environment variable name')
  let baseUrl = profile.baseUrl ?? 'https://api.openai.com/v1'
  try { const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw 0 } catch { throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL') }
  return { id: profile.id, provider: profile.provider, model: profile.model, protocol: profile.protocol, apiKeyEnv: profile.apiKeyEnv, baseUrl, ...(typeof profile.name === 'string' ? { name: profile.name } : {}) }
}
function routeKey(profile) { return JSON.stringify({ id: profile.id, provider: profile.provider, model: profile.model, protocol: profile.protocol, baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv }) }
function renderConfig(profile) { return `active_model = "talent_host"\ndefault_agent = "auto-approve"\nlog_interactions = true\nenable_auto_update = false\nenable_telemetry = false\nenable_notifications = false\n\n[[providers]]\nname = "talent_host"\napi_base = ${toml(profile.baseUrl)}\napi_key_env_var = "${ENV_KEY}"\napi_style = "openai"\nbackend = "generic"\n\n[[models]]\nname = ${toml(profile.model)}\nprovider = "talent_host"\nalias = "talent_host"\ndisplay_name = ${toml(profile.name ?? profile.model)}\nsupports_images = false\n` }
function toml(value) { return JSON.stringify(String(value)) }
function isolateEnvironment(source, credential, home) {
  const env = { ...source }
  for (const name of Object.keys(env)) if (/^VIBE_/i.test(name) || /^MISTRAL_/i.test(name) || /^OPENAI_/i.test(name) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name === 'NODE_OPTIONS') delete env[name]
  env[ENV_KEY] = credential; env.VIBE_HOME = home; env.HOME = home; env.XDG_CONFIG_HOME = resolve(home, 'xdg-config'); env.XDG_CACHE_HOME = resolve(home, 'xdg-cache'); env.PYTHONUNBUFFERED = '1'; env.BROWSER = '/usr/bin/true'
  return env
}
function collectSecrets(env, selected) { return [...new Set([selected, ...Object.entries(env).filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)])] }
function redact(text, secrets) { let safe = String(text); for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]'); return safe }
function redactDeep(value, secrets) { if (typeof value === 'string') return redact(value, secrets); if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)])) }
function extractText(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join(''); if (content && typeof content === 'object') return content.text ?? content.content?.text ?? ''; return '' }
async function terminate(task) { if (!task.child || task.closed) return; signalTree(task.child, 'SIGTERM'); if (!await waitClose(task.closePromise, task.grace) && !task.closed) { signalTree(task.child, 'SIGKILL'); await task.closePromise } }
function signalTree(child, signal) { if (process.platform === 'win32' || !child.pid) child.kill(signal); else { try { process.kill(-child.pid, signal) } catch (error) { if (error?.code !== 'ESRCH') child.kill(signal) } } }
async function readSessions(file) {
  let contents
  try { contents = await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  const value = JSON.parse(contents)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, id]) => !/^[a-f0-9]{64}$/.test(key) || typeof id !== 'string' || !id)) throw new Error('Invalid Mistral Vibe session store')
  return value
}
function eventQueue() { const items = []; let wake, finished = false; return { push(item) { items.push(item); wake?.(); wake = null }, finish() { finished = true; wake?.(); wake = null }, async next() { while (!items.length && !finished) await new Promise(resolvePromise => { wake = resolvePromise }); return items.length ? { value: items.shift(), done: false } : { done: true } } } }
async function waitClose(promise, ms) { let timer; return Promise.race([promise.then(() => true), new Promise(resolvePromise => { timer = setTimeout(() => resolvePromise(false), ms) })]).finally(() => clearTimeout(timer)) }
