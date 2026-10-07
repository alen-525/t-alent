import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createAgentPackage(options) {
  const entry = fileURLToPath(import.meta.resolve('@continuedev/cli'))
  return createAgentPackageWithRuntime(options, { command: process.execPath, bin: resolve(dirname(entry), 'cn.js'), spawnProcess: spawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  for (const key of Object.keys(config)) if (!['permissions', 'cancelGraceMs'].includes(key)) throw new TypeError(`Unsupported Continue behavior config: ${key}; model routing comes from the host`)
  const permissions = config.permissions ?? 'readonly'
  if (!['readonly', 'auto'].includes(permissions)) throw new TypeError('permissions must be readonly or auto')
  const grace = config.cancelGraceMs ?? 3000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('Invalid cancelGraceMs')
  const root = resolve(workspace), state = resolve(stateDir)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const environment = { ...process.env, ...(env ?? {}) }
  let active, disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Continue package is disposed')
    if (active) throw new Error('Continue package already has an active task')
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and input are required')
    const profile = validateProfile(model)
    const apiKey = environment[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`Missing model API key environment variable ${profile.apiKeyEnv}`)
    const key = hash(JSON.stringify([root, sessionId || taskId, profile]))
    const task = { taskId, profile, apiKey, key, queue: eventQueue(), signal, cancelling: !!signal?.aborted, child: null, closed: false,
      secrets: [...new Set([apiKey, ...Object.entries(environment).filter(([k,v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)])] }
    active = task
    task.finished = Promise.resolve().then(() => run(task, input))
    task.abort = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abort, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try { for (;;) { const next = await task.queue.next(); if (next.done) return; yield next.value } }
        finally { if (active === task) await cancelTask(taskId) }
      },
    }
  }

  async function run(task, input) {
    const emit = event => task.queue.push(redact(event, task.secrets))
    let stdout = '', stderr = '', overflow
    try {
      if (task.cancelling) return
      const home = resolve(state, 'conversations', task.key)
      const continueDir = resolve(home, '.continue')
      await mkdir(continueDir, { recursive: true, mode: 0o700 })
      const configPath = resolve(continueDir, 'config.yaml')
      const provider = task.profile.protocol === 'anthropic' ? 'anthropic' : 'openai'
      // JSON is valid YAML; keep the selected secret in the child environment.
      const settings = { name: 't-alent external profile', version: '1.0.0', schema: 'v1', models: [{ name: task.profile.id, provider, model: task.profile.model,
        apiKey: '${{ secrets.TALENT_CONTINUE_MODEL_KEY }}', roles: ['chat'], ...(task.profile.baseUrl ? { apiBase: task.profile.baseUrl } : {}) }] }
      await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 })
      const previous = await latestSession(continueDir)
      const childEnv = { ...environment }
      for (const k of Object.keys(childEnv)) if (/^(CONTINUE_|ANTHROPIC_|OPENAI_|OTEL_|NODE_OPTIONS$|TALENT_CONTINUE_)/.test(k)) delete childEnv[k]
      Object.assign(childEnv, { HOME: home, CONTINUE_GLOBAL_DIR: continueDir, TALENT_CONTINUE_MODEL_KEY: task.apiKey,
        CONTINUE_CLI_ENABLE_TELEMETRY: '0', CONTINUE_METRICS_ENABLED: '0', CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE: '1', NO_COLOR: '1' })
      const args = [runtime.bin, '-p', '--config', configPath, permissions === 'auto' ? '--auto' : '--readonly', ...(previous ? ['--resume'] : [])]
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
        stdout += chunk
        if (stdout.length > 8 * 1024 * 1024) { overflow = new Error('Continue output exceeded 8 MiB'); void cancelTask(task.taskId) }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      const outcome = await task.close
      if (overflow) throw overflow
      if (task.cancelling) return
      if (outcome.spawnError) throw outcome.spawnError
      if (outcome.code !== 0) throw new Error(`Continue exited ${outcome.code}: ${stderr}`)
      const session = await latestSession(continueDir)
      if (!session || !Array.isArray(session.history) || typeof session.sessionId !== 'string') throw new Error('Continue exited without a persisted native session')
      emit({ type: 'session', sessionId: session.sessionId })
      // This CLI exposes final text, not a native streaming tool-event protocol.
      // Emit actual tool messages from the saved native turn after completion.
      const oldLength = previous?.history?.length ?? 0
      for (const item of session.history.slice(oldLength)) {
        const message = item?.message
        if (message?.role === 'assistant' && Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) emit({ type: 'tool-call', name: call.function?.name ?? 'unknown', callId: call.id, input: call.function?.arguments })
        } else if (message?.role === 'tool') emit({ type: 'tool-result', name: 'native-tool', callId: message.toolCallId, output: message.content })
      }
      if (!stdout.trim()) throw new Error('Continue exited without an assistant response')
      emit({ type: 'assistant-replace', text: stdout.trimEnd() })
      emit({ type: 'assistant-complete' })
    } catch (e) {
      if (task.child && !task.closed) await stopChild(task, grace)
      if (!task.cancelling || overflow) emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
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
  if (!['openai-chat-completions', 'anthropic'].includes(model.protocol)) throw new TypeError(`Unsupported model protocol ${model.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv) || model.model.length > 200 || model.id.length > 200) throw new TypeError('Invalid model profile')
  if (model.baseUrl !== undefined) {
    const url = new URL(model.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid model baseUrl')
  }
  return Object.fromEntries(['id', 'provider', 'model', 'protocol', 'apiKeyEnv', 'baseUrl'].filter(k => model[k] !== undefined).map(k => [k, model[k]]))
}
async function latestSession(dir) {
  const sessions = resolve(dir, 'sessions')
  let files
  try { files = (await readdir(sessions)).filter(name => name.endsWith('.json') && name !== 'sessions.json') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const rows = await Promise.all(files.map(async name => ({ file: resolve(sessions, name), modified: (await stat(resolve(sessions, name))).mtimeMs })))
  rows.sort((a,b) => b.modified - a.modified)
  return rows.length ? JSON.parse(await readFile(rows[0].file, 'utf8')) : null
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
  kill('SIGKILL')
  await task.close
}
