import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const mapFile = 'opencode-sessions.json'
const protocols = new Set(['openai-chat-completions', 'anthropic', 'openai-responses'])

export async function createAgentPackage(options) {
  const packageJson = require.resolve('opencode-ai/package.json')
  const bin = resolve(dirname(packageJson), 'bin/opencode.exe')
  return createAgentPackageWithRuntime(options, { command: bin, spawnProcess: spawn })
}

/** Runtime seam for package tests. Production uses the fixed official OpenCode CLI. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  for (const key of ['model', 'provider', 'baseUrl', 'baseURL', 'apiKey', 'apiKeyEnv']) {
    if (config[key] !== undefined) throw new TypeError(`config.${key} is not supported; model routing must come from the external model profile`)
  }
  const root = resolve(workspace)
  const state = resolve(stateDir)
  const home = resolve(state, 'opencode-home')
  const dirs = {
    config: resolve(state, 'config'), data: resolve(state, 'data'), cache: resolve(state, 'cache'), state: resolve(state, 'runtime'),
  }
  await Promise.all([home, ...Object.values(dirs)].map(path => mkdir(path, { recursive: true })))
  const baseEnv = { ...process.env, ...(env ?? {}) }
  const sessionsPath = resolve(state, mapFile)
  const sessions = await readMap(sessionsPath)
  let active
  let disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('OpenCode agent package is disposed')
    if (active) throw new Error(`OpenCode agent package already has active task ${active.taskId}`)
    if (!taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const secret = baseEnv[profile.apiKeyEnv]
    if (typeof secret !== 'string' || !secret) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const fingerprint = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    const conversationKey = `${String(sessionId || taskId)}\0${fingerprint}`
    const providerId = `talent-${fingerprint.slice(0, 16)}`
    const modelId = profile.model
    const secretEnvName = 'TALENT_OPENCODE_PROFILE_KEY'
    const taskEnv = { ...baseEnv }
    for (const key of Object.keys(taskEnv)) if ((/^OPENCODE_/.test(key) && !/^OPENCODE_TEST_/.test(key)) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^NODE_OPTIONS$/i.test(key)) delete taskEnv[key]
    taskEnv[secretEnvName] = secret
    delete taskEnv[profile.apiKeyEnv]
    taskEnv.HOME = home
    taskEnv.XDG_CONFIG_HOME = dirs.config
    taskEnv.XDG_DATA_HOME = dirs.data
    taskEnv.XDG_CACHE_HOME = dirs.cache
    taskEnv.OPENCODE_CONFIG_DIR = dirs.config
    taskEnv.OPENCODE_DATA_DIR = dirs.data
    taskEnv.OPENCODE_CACHE_DIR = dirs.cache
    taskEnv.OPENCODE_STATE_DIR = dirs.state
    taskEnv.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
    taskEnv.OPENCODE_CONFIG = resolve(state, `task-${safeId(taskId)}.json`)
    const configFile = taskEnv.OPENCODE_CONFIG
    const configDoc = opencodeConfig(profile, providerId, secretEnvName)
    const secrets = [...new Set([secret, ...Object.entries(baseEnv).filter(([k,v]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length > 3).map(([,v]) => v)])]
    const task = { taskId, profile, conversationKey, providerId, modelId, taskEnv, configFile, configDoc, secrets, signal, queue: eventQueue(), child: null, closed: false, cancelling: false, settled: false, cancelPromise: null, closePromise: null, abortListener: null, persistenceError: null }
    task.persistPromise = Promise.resolve()
    task.acceptSession = id => acceptSession(task, id)
    active = task
    task.finished = run(task, input)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try { while (true) { const next = await task.queue.next(); if (next.done) return; yield next.value } }
        finally { if (!task.settled) await cancelTask(taskId) }
      },
    }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      const child = task.child
      if (child && !task.closed) {
        killTaskProcess(child, 'SIGINT')
        await waitClose(task.closePromise, config.cancelGraceMs ?? 7000)
        killTaskProcess(child, 'SIGKILL')
        await task.closePromise
      }
      await task.finished
    })()
    await task.cancelPromise
  }

  async function run(task, input) {
    let stdout = ''
    let stderr = ''
    let sawText = false
    let finalText = ''
    let parseError
    try {
      const prior = sessions[task.conversationKey]
      await writeFile(task.configFile, JSON.stringify(task.configDoc), { mode: 0o600 })
      if (task.cancelling || task.signal?.aborted) return
      await runtime.beforeSpawn?.()
      if (task.cancelling || task.signal?.aborted) return
      const args = ['run', '--pure', '--format', 'json', '--auto', '--model', `${task.providerId}/${task.modelId}`, '--dir', root, ...(prior ? ['--session', prior] : []), input]
      const child = runtime.spawnProcess(runtime.command, [...(runtime.bin ? [runtime.bin] : []), ...args], { cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      task.child = child
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { task.spawnError = error })
        child.once('close', (code, terminationSignal) => { task.closed = true; resolveClose({ code, signal: terminationSignal }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
        let idx
        while ((idx = stdout.indexOf('\n')) >= 0) { const line = stdout.slice(0, idx); stdout = stdout.slice(idx + 1); acceptLine(task, line, value => { sawText = true; finalText += value }, err => { parseError ??= err }) }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk.slice(0, 12000 - stderr.length) })
      const outcome = await task.closePromise
      if (stdout.trim() && !task.cancelling) acceptLine(task, stdout, value => { sawText = true; finalText += value }, err => { parseError ??= err })
      if (task.cancelling || task.signal?.aborted) return
      await task.persistPromise
      if (task.persistenceError) throw task.persistenceError
      if (task.spawnError) throw task.spawnError
      if (parseError) throw parseError
      if (outcome.code !== 0 || !sawText) throw new Error(redact(outcome.code === 0 ? 'OpenCode exited without an assistant text event' : (stderr.trim() || `OpenCode exited with code ${outcome.code}`), task.secrets))
      task.queue.push({ type: 'assistant-replace', text: finalText })
      task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) { killTaskProcess(task.child, 'SIGTERM'); await task.closePromise?.catch(() => {}) }
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(error?.message || String(error), task.secrets) })
    } finally {
      await rm(task.configFile, { force: true }).catch(() => {})
      task.abortListener && task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelling && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }

async function acceptSession(task, id) {
    if (!id || sessions[task.conversationKey] === id) return
    sessions[task.conversationKey] = id
    task.persistPromise = task.persistPromise.then(async () => {
      const tmp = `${sessionsPath}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 }); await rename(tmp, sessionsPath)
    })
    await task.persistPromise
  }
}

function acceptLine(task, line, onText, onError) {
  if (task.cancelling || !line.trim()) return
  let event
  try { event = JSON.parse(line) } catch { onError(new Error('OpenCode emitted malformed JSON')); return }
  if (!event || typeof event.type !== 'string') return
  const sessionId = event.sessionID ?? event.part?.sessionID
  if (sessionId && task.knownSessionId !== sessionId) {
    task.knownSessionId = sessionId
    task.queue.push({ type: 'session', sessionId })
    void task.acceptSession?.(sessionId).catch(error => { task.persistenceError = error })
  }
  const part = event.part ?? {}
  if (event.type === 'text' && typeof part.text === 'string' && !part.synthetic) {
    const text = redact(part.text, task.secrets)
    onText(text)
    task.queue.push({ type: 'assistant-delta', text })
  } else if (event.type === 'tool_use' || event.type === 'tool-call') {
    task.queue.push({ type: 'tool-call', name: redact(part.tool ?? part.name ?? 'tool', task.secrets), input: redactDeep(part.state?.input ?? part.input, task.secrets), callId: redact(part.callID ?? part.id ?? '', task.secrets) })
    // Native `run --format json` reports a completed ToolPart in tool_use.
    if (['completed', 'error'].includes(part.state?.status)) task.queue.push({ type: 'tool-result', name: redact(part.tool ?? part.name ?? 'tool', task.secrets), output: redactDeep(part.state.output ?? part.state.error ?? '', task.secrets), callId: redact(part.callID ?? part.id ?? '', task.secrets), status: part.state.status === 'error' ? 'error' : 'success' })
  } else if (event.type === 'tool_result' || event.type === 'tool-result') {
    task.queue.push({ type: 'tool-result', name: redact(part.tool ?? part.name ?? 'tool', task.secrets), output: redact(typeof part.state?.output === 'string' ? part.state.output : JSON.stringify(part.state?.output ?? part.output ?? ''), task.secrets), callId: redact(part.callID ?? part.id ?? '', task.secrets) })
  } else if (event.type === 'error') onError(new Error(redact(event.error?.message ?? event.message ?? 'OpenCode reported an error', task.secrets)))
  else if (event.type === 'step_start' || event.type === 'step_finish') task.queue.push({ type: 'harness-event', event: redactDeep(event, task.secrets) })
}

function opencodeConfig(profile, providerId, keyEnv) {
  const endpoint = profile.baseUrl ?? ({ 'openai-chat-completions': 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' })[profile.protocol]
  const sdk = ({ 'openai-chat-completions': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' })[profile.protocol]
  return {
    model: `${providerId}/${profile.model}`,
    provider: { [providerId]: { npm: sdk, name: `External profile ${profile.id}`, options: { baseURL: endpoint, apiKey: `{env:${keyEnv}}` }, models: { [profile.model]: { name: profile.name ?? profile.model } } } },
    permission: { '*': 'allow' },
  }
}
function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new TypeError('model profile is required')
  for (const k of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > 512) throw new TypeError(`model profile ${k} is required and must be at most 512 characters`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv) || p.apiKeyEnv === 'TALENT_OPENCODE_PROFILE_KEY') throw new TypeError('model profile apiKeyEnv must be a valid, non-reserved environment variable name')
  if (!protocols.has(p.protocol)) throw new TypeError(`unsupported model profile protocol: ${p.protocol}`)
  if (p.baseUrl !== undefined) { let u; try { u = new URL(p.baseUrl) } catch { throw new TypeError('model profile baseUrl must be a valid HTTP(S) URL') }; if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL') }
  return { ...p }
}
function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'task' }
function redact(text, secrets) { let value = String(text); for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value }
function redactDeep(value, secrets) { if (typeof value === 'string') return redact(value, secrets); if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redactDeep(v,secrets)])) }
async function readMap(path) {
  let source
  try { source = await readFile(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return {}; throw error }
  const map = JSON.parse(source)
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('OpenCode session map must contain a JSON object')
  return map
}
function killTaskProcess(child, signal) {
  if (process.platform === 'win32' || !child.pid) { child.kill(signal); return }
  try { process.kill(-child.pid, signal) } catch (error) { if (error?.code !== 'ESRCH') child.kill(signal) }
}
function eventQueue() { const items = []; let wake; let finished = false; return { push(item) { items.push(item); wake?.(); wake = null }, finish() { finished = true; wake?.(); wake = null }, async next() { while (!items.length && !finished) await new Promise(resolveWake => { wake = resolveWake }); return items.length ? { value: items.shift(), done: false } : { done: true } } } }
async function waitClose(promise, ms) {
  let timer
  return Promise.race([promise.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), Math.max(1, Math.min(ms, 60000))) })]).finally(() => clearTimeout(timer))
}
