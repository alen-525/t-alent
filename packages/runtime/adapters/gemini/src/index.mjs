import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createAgentPackage(options) {
  return createAgentPackageWithRuntime(options, {
    spawnProcess: spawn,
    command: process.execPath,
    resolveBin: () => fileURLToPath(import.meta.resolve('@google/gemini-cli/bundle/gemini.js')),
  })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  const allowed = ['approvalMode', 'cancelGraceMs', 'maxSessionTurns']
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new TypeError(`Unsupported Gemini behavior config: ${key}; models come from the host profile`)
  const approvalMode = config.approvalMode ?? 'auto_edit'
  if (!['default', 'auto_edit', 'plan'].includes(approvalMode)) throw new TypeError('approvalMode must be default, auto_edit, or plan')
  const grace = config.cancelGraceMs ?? 3000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('Invalid cancelGraceMs')
  if (config.maxSessionTurns !== undefined && (!Number.isSafeInteger(config.maxSessionTurns) || config.maxSessionTurns < 1)) throw new TypeError('Invalid maxSessionTurns')
  const root = resolve(workspace), state = resolve(stateDir)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const environment = { ...process.env, ...(env ?? {}) }
  const sessionsPath = resolve(state, 'sessions.json')
  const sessions = await readSessions(sessionsPath)
  let active, disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Gemini package is disposed')
    if (active) throw new Error('Gemini package already has an active task')
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and input are required')
    const profile = validateProfile(model)
    const apiKey = environment[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`Missing model API key environment variable ${profile.apiKeyEnv}`)
    const fingerprint = hash(JSON.stringify(profile))
    const key = hash(`${sessionId || taskId}\0${fingerprint}`)
    const queue = eventQueue()
    const task = { taskId, key, profile, apiKey, queue, signal, cancelling: !!signal?.aborted, child: null, closed: false,
      secrets: [...new Set([apiKey, ...Object.entries(environment).filter(([k,v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)])] }
    active = task
    task.finished = Promise.resolve().then(() => run(task, input))
    task.abort = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abort, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try { for (;;) { const next = await queue.next(); if (next.done) return; yield next.value } }
        finally { if (active === task) await cancelTask(taskId) }
      },
    }
  }

  async function run(task, input) {
    let pendingSave = Promise.resolve(), parseError, final, error, text = '', stderr = '', buffer = ''
    const tools = new Map()
    const emit = event => task.queue.push(redact(event, task.secrets))
    const accept = line => {
      if (!line.trim() || task.cancelling) return
      try {
        const e = JSON.parse(line)
        if (!e || typeof e !== 'object' || typeof e.type !== 'string') throw new Error('Malformed Gemini event')
        switch (e.type) {
          case 'init':
            if (typeof e.session_id !== 'string' || !e.session_id) throw new Error('Missing Gemini session id')
            sessions[task.key] = e.session_id
            pendingSave = pendingSave.then(async () => {
              const tmp = `${sessionsPath}.${randomUUID()}.tmp`
              await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 }); await rename(tmp, sessionsPath)
            })
            // Handle rejected I/O while the child is still producing output.
            pendingSave.catch(() => {})
            emit({ type: 'session', sessionId: e.session_id }); break
          case 'message':
            if (e.role === 'assistant') {
              if (typeof e.content !== 'string') throw new Error('Malformed Gemini assistant message')
              text = e.delta ? text + e.content : e.content
              emit({ type: e.delta ? 'assistant-delta' : 'assistant-replace', text: e.content })
            }
            break
          case 'tool_use':
            tools.set(e.tool_id, e.tool_name)
            emit({ type: 'tool-call', name: e.tool_name, callId: e.tool_id, input: e.parameters }); break
          case 'tool_result':
            emit({ type: 'tool-result', name: tools.get(e.tool_id) ?? 'unknown', callId: e.tool_id, status: e.status, output: e.output ?? e.error }); break
          case 'error':
            if (e.severity !== 'warning') error = e.message ?? 'Gemini Harness error'
            emit({ type: 'harness-event', event: e }); break
          case 'result': final = e; emit({ type: 'harness-event', event: e }); break
          default: emit({ type: 'harness-event', event: e })
        }
      } catch (e) { parseError = e }
    }
    try {
      if (task.cancelling) return
      const home = resolve(state, 'homes', hash(JSON.stringify(task.profile)))
      const settingsDir = resolve(home, '.gemini')
      await mkdir(settingsDir, { recursive: true, mode: 0o700 })
      // The pinned CLI requires root-owned system settings. Use an isolated user
      // home and reject workspace settings that could override this model route.
      let hasWorkspaceSettings = false
      try { await access(resolve(root, '.gemini', 'settings.json')); hasWorkspaceSettings = true } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (hasWorkspaceSettings) throw new Error('Workspace .gemini/settings.json would override the external profile; use package behavior config in an isolated workspace')
      const settingsPath = resolve(settingsDir, 'settings.json')
      const authType = 'gemini-api-key'
      const settings = {
        security: { auth: { selectedType: authType, enforcedType: authType }, folderTrust: { enabled: false } },
        general: { disableAutoUpdate: true, enableAutoUpdate: false, retryFetchErrors: false, plan: { modelRouting: false } },
        advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
        telemetry: { enabled: false }, usageStatisticsEnabled: false,
        model: { name: task.profile.model, ...(config.maxSessionTurns ? { maxSessionTurns: config.maxSessionTurns } : {}) },
      }
      await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 })
      const childEnv = { ...environment }
      for (const k of Object.keys(childEnv)) if (/^(GEMINI_|GOOGLE_|GCLOUD_|CLOUD_SHELL|OTEL_|NODE_OPTIONS)/.test(k)) delete childEnv[k]
      childEnv.GEMINI_API_KEY = task.apiKey
      childEnv.GEMINI_CLI_HOME = home
      childEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = resolve(home, 'nonexistent-system.json')
      childEnv.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = resolve(home, 'nonexistent-defaults.json')
      childEnv.GEMINI_CLI_NO_RELAUNCH = 'true'
      childEnv.NO_COLOR = '1'
      if (task.profile.baseUrl) childEnv.GOOGLE_GEMINI_BASE_URL = task.profile.baseUrl
      const bin = runtime.bin ?? runtime.resolveBin()
      const args = [bin, '--output-format', 'stream-json', '--model', task.profile.model, '--approval-mode', approvalMode,
        ...(sessions[task.key] ? ['--resume', sessions[task.key]] : [])]
      await runtime.beforeSpawn?.()
      if (task.cancelling) return
      const child = runtime.spawnProcess(runtime.command, args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' })
      task.child = child
      task.close = new Promise(resolveClose => {
        let spawnError
        child.once('error', e => { spawnError = e })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, spawnError }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); accept(line) }
        if (buffer.length > 4 * 1024 * 1024) { parseError = new Error('Gemini JSON event exceeded 4 MiB'); void cancelTask(task.taskId) }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      const outcome = await task.close
      if (buffer.trim()) accept(buffer)
      await pendingSave
      if (task.cancelling) return
      if (outcome.spawnError) throw outcome.spawnError
      if (parseError) throw parseError
      if (outcome.code !== 0 || error || final?.status !== 'success') throw new Error(error ?? `Gemini exited ${outcome.code} without success: ${stderr}`)
      emit({ type: 'assistant-replace', text }); emit({ type: 'assistant-complete' })
    } catch (e) {
      if (task.child && !task.closed) await stopChild(task, grace)
      if (!task.cancelling) emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      task.signal?.removeEventListener('abort', task.abort)
      if (task.cancelling) emit({ type: 'cancelled' })
      if (active === task) active = null
      task.queue.finish()
    }
  }
  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId) return
    task.cancelling = true
    task.cancelPromise ??= (async () => { if (task.child && !task.closed) await stopChild(task, grace); await task.finished })()
    await task.cancelPromise
  }
  async function dispose() { disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

function validateProfile(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof model[key] !== 'string' || !model[key].trim() || model[key] !== model[key].trim()) throw new TypeError(`Invalid model profile ${key}`)
  if (model.protocol !== 'google-generative-ai') throw new TypeError(`Unsupported model protocol ${model.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv) || model.model.length > 200 || model.id.length > 200) throw new TypeError('Invalid model profile')
  if (model.baseUrl !== undefined) {
    const url = new URL(model.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid model baseUrl')
  }
  return Object.fromEntries(['id', 'provider', 'model', 'protocol', 'apiKeyEnv', 'baseUrl'].filter(k => model[k] !== undefined).map(k => [k, model[k]]))
}
async function readSessions(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string' || !v)) throw new Error('Invalid session map')
    return Object.assign(Object.create(null), value)
  } catch (e) { if (e.code === 'ENOENT') return Object.create(null); throw e }
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function redact(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((v, s) => v.replaceAll(s, '[redacted]'), value)
  if (Array.isArray(value)) return value.map(v => redact(v, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v, secrets)]))
  return value
}
function eventQueue() {
  const values = [], waiting = []; let done = false
  return {
    push(value) { if (!done) { if (waiting.length) waiting.shift()({ value, done: false }); else values.push(value) } },
    finish() { done = true; while (waiting.length) waiting.shift()({ done: true }) },
    next() { return values.length ? Promise.resolve({ value: values.shift(), done: false }) : done ? Promise.resolve({ done: true }) : new Promise(r => waiting.push(r)) },
  }
}
async function stopChild(task, grace) {
  const kill = signal => { try { if (process.platform !== 'win32' && task.child.pid) process.kill(-task.child.pid, signal); else task.child.kill(signal) } catch (e) { if (e.code !== 'ESRCH') throw e } }
  kill('SIGTERM')
  let timer
  try { await Promise.race([task.close, new Promise(r => { timer = setTimeout(r, grace) })]) } finally { clearTimeout(timer) }
  // Kill descendants as well, even if their parent already exited.
  kill('SIGKILL')
  await task.close
}
