import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageDir = dirname(fileURLToPath(import.meta.url))
const sessionMapFile = 'goose-sessions.json'
const PINNED_VERSION = '1.48.0'
const execFile = promisify(execFileCallback)

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  const command = config.program ?? env?.GOOSE_BIN ?? process.env.GOOSE_BIN ?? resolve(stateDir, 'goose-runtime', 'goose')
  await assertPinnedRuntime(command)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command, spawnProcess: spawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace) throw new TypeError('workspace is required')
  if (!stateDir) throw new TypeError('stateDir is required')
  rejectLegacyConfig(config)
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Goose runtime command and spawnProcess are required')
  const root = resolve(workspace)
  const state = resolve(stateDir)
  await mkdir(state, { recursive: true })
  const sessionsFile = resolve(state, sessionMapFile)
  const sessions = await readSessionMap(sessionsFile)
  const graceMs = Number.isSafeInteger(config.cancelGraceMs) && config.cancelGraceMs > 0 ? Math.min(config.cancelGraceMs, 60_000) : 5_000
  let active = null
  let disposed = false

  async function persistSessions() {
    const tmp = `${sessionsFile}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 })
    await rename(tmp, sessionsFile)
  }

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Goose agent package is disposed')
    if (active) throw new Error(`Goose agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const conversationKey = `${String(sessionId || taskId)}\0${profileFingerprint(profile)}`
    const sessionName = `talent-${createHash('sha256').update(conversationKey).digest('hex').slice(0, 32)}`
    const isolated = resolve(state, 'profiles', createHash('sha256').update(profileFingerprint(profile)).digest('hex'))
    const hostEnv = { ...process.env, ...(env ?? {}) }
    const key = hostEnv[profile.apiKeyEnv]
    if (typeof key !== 'string' || !key) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const taskEnv = isolatedEnvironment(hostEnv, profile, isolated)
    const secrets = gatherSecrets(hostEnv, key)
    const task = {
      taskId, profile, conversationKey, sessionName, taskEnv, secrets,
      child: null, closed: false, closePromise: null, childReady: null,
      signalChildReady: null, cancelling: false, settled: false, cancelPromise: null,
      queue: eventQueue(), signal, abortListener: null, error: null, errorEventSent: false, completed: false,
      assistantText: '', toolNames: new Map(), seenToolCalls: new Set(), sessionEventSent: false, persistenceError: null, persistPromise: Promise.resolve(),
    }
    task.childReady = new Promise(resolveReady => { task.signalChildReady = resolveReady })
    active = task
    task.finished = run(task, input)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const item = await task.queue.next()
            if (item.done) return
            yield item.value
          }
        } finally {
          if (!task.settled) await cancelTask(taskId)
        }
      },
    }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      await Promise.race([task.childReady, task.finished])
      if (task.child && !task.closed) {
        signalProcessTree(task.child, 'SIGINT')
        if (!await waitForClose(task.closePromise, graceMs)) {
          signalProcessTree(task.child, 'SIGKILL')
          await task.closePromise
        }
        signalProcessTree(task.child, 'SIGKILL')
      }
      await task.finished
    })()
    await task.cancelPromise
  }

  async function run(task, input) {
    let stdoutBuffer = ''
    let stderrBuffer = ''
    const wasResuming = Boolean(sessions[task.conversationKey])
    try {
      await Promise.all([task.taskEnv.GOOSE_CONFIG_DIR, task.taskEnv.HOME, task.taskEnv.XDG_DATA_HOME, task.taskEnv.XDG_STATE_HOME, task.taskEnv.XDG_CACHE_HOME].map(dir => mkdir(dir, { recursive: true })))
      if (task.cancelling || task.signal?.aborted) return
      const args = [
        'run', '--instructions', '-', '--output-format', 'stream-json', '--quiet',
        '--no-profile', '--with-builtin', 'developer', '--name', task.sessionName,
        ...(wasResuming ? ['--resume'] : []),
        '--provider', 'openai', '--model', task.profile.model,
      ]
      const child = runtime.spawnProcess(runtime.command, args, {
        cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      task.child = child
      task.signalChildReady()
      let spawnError
      task.closePromise = new Promise(resolveClose => {
        child.once('error', error => { spawnError = error })
        child.once('close', (code, terminationSignal) => {
          task.closed = true
          resolveClose({ code, signal: terminationSignal, error: spawnError })
        })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        if (task.cancelling) return
        stdoutBuffer += chunk
        let newline
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline)
          stdoutBuffer = stdoutBuffer.slice(newline + 1)
          acceptLine(task, line, () => {
            task.persistPromise = task.persistPromise.then(async () => {
              sessions[task.conversationKey] = task.sessionName
              await persistSessions()
            }).catch(error => { task.persistenceError = error })
          })
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { if (stderrBuffer.length < 16_384) stderrBuffer += String(chunk).slice(0, 16_384 - stderrBuffer.length) })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      const outcome = await task.closePromise
      if (stdoutBuffer.trim() && !task.cancelling) acceptLine(task, stdoutBuffer, () => {
        task.persistPromise = task.persistPromise.then(async () => {
          sessions[task.conversationKey] = task.sessionName
          await persistSessions()
        }).catch(error => { task.persistenceError = error })
      })
      await task.persistPromise
      if (task.persistenceError) throw task.persistenceError
      if (task.cancelling || task.signal?.aborted) return
      if (outcome.error?.code === 'ENOENT') throw new Error(`Pinned Goose CLI v${PINNED_VERSION} was not found at ${runtime.command}. Run the setup:runtime script: node packages/runtime/adapters/goose/scripts/setup-runtime.mjs --state-dir ${state}, or set config.program/GOOSE_BIN.`)
      if (outcome.code !== 0 || task.error || !task.completed) {
        throw new Error(task.error ?? redact(`Goose exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`} without a completed stream event${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-6000)}` : ''}`, task.secrets))
      }
      task.queue.push({ type: 'assistant-replace', text: task.assistantText })
      task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) {
        signalProcessTree(task.child, 'SIGTERM')
        await task.closePromise?.catch(() => {})
      }
      if (!task.cancelling && !task.signal?.aborted && !task.errorEventSent) {
        task.errorEventSent = true
        task.queue.push({ type: 'error', message: redact(safeMessage(error), task.secrets) })
      }
    } finally {
      task.signalChildReady?.()
      if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelling && !task.cancelEventSent) {
        task.cancelEventSent = true
        task.queue.push({ type: 'cancelled' })
      }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    if (active) await cancelTask(active.taskId)
  }
  return { executeTask, cancelTask, dispose }
}

function acceptLine(task, line, onSession) {
  if (!line.trim() || task.cancelling) return
  let event
  try { event = JSON.parse(line) }
  catch {
    task.error = redact(`Goose emitted invalid JSON: ${line.slice(0, 300)}`, task.secrets)
    task.errorEventSent = true
    task.queue.push({ type: 'error', message: task.error })
    return
  }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    task.error = 'Goose emitted a malformed stream event'
    task.errorEventSent = true
    task.queue.push({ type: 'error', message: task.error })
    return
  }
  const safeEvent = redactDeep(event, task.secrets)
  if (event.type === 'message') {
    if (!task.sessionEventSent) {
      task.sessionEventSent = true
      void onSession()
      task.queue.push({ type: 'session', sessionId: task.sessionName })
    }
    for (const block of event.message?.content ?? []) {
      const kind = String(block.type ?? '').toLowerCase().replaceAll('_', '')
      if (kind === 'text' && event.message.role === 'assistant' && typeof block.text === 'string') {
        const text = redact(block.text, task.secrets)
        if (!task.assistantText.endsWith(text)) {
          const delta = text.startsWith(task.assistantText) ? text.slice(task.assistantText.length) : text
          if (delta) task.queue.push({ type: 'assistant-delta', text: delta })
          task.assistantText = text.startsWith(task.assistantText) ? text : `${task.assistantText}${text}`
        }
      } else if (kind === 'thinking' && typeof block.thinking === 'string') {
        task.queue.push({ type: 'reasoning', text: redact(block.thinking, task.secrets) })
      } else if (kind === 'error') {
        task.error = redact(typeof block.message === 'string' ? block.message : JSON.stringify(block), task.secrets)
        if (!task.errorEventSent) {
          task.errorEventSent = true
          task.queue.push({ type: 'error', message: task.error })
        }
      } else if (kind === 'toolrequest' || kind === 'toolcall') {
        const call = block.toolCall?.value ?? block.tool_call?.value ?? block
        const id = block.id ?? block.tool_call_id ?? block.toolCallId ?? block.call_id
        const tool = call.name ?? block.name ?? block.tool_name ?? block.toolName
        if (typeof id === 'string' && typeof tool === 'string') {
          task.toolNames.set(id, tool)
          if (!task.seenToolCalls.has(id)) {
            task.seenToolCalls.add(id)
            task.queue.push({ type: 'tool-call', name: tool, input: redactDeep(call.arguments ?? block.arguments ?? block.input ?? block.value, task.secrets), callId: id })
          }
        } else task.queue.push({ type: 'harness-event', event: safeEvent })
      } else if (kind === 'toolresponse' || kind === 'toolresult') {
        const id = block.id ?? block.tool_call_id ?? block.toolCallId ?? block.call_id
        const result = block.toolResult?.value ?? block.tool_result?.value ?? block
        const tool = task.toolNames.get(id) ?? block.name ?? block.tool_name
        const rawOutput = result.result ?? result.output ?? result.content ?? block.content ?? block.output ?? block.text
        const output = typeof rawOutput === 'string' ? rawOutput : Array.isArray(rawOutput) ? rawOutput.map(part => part.text ?? '').join('') : undefined
        const failed = result.isError === true || result.is_error === true || result.status === 'error'
        if (typeof output === 'string') task.queue.push({ type: 'tool-result', name: tool, output: redact(output, task.secrets), status: failed ? 'error' : 'success', callId: id })
        else task.queue.push({ type: 'harness-event', event: safeEvent })
      }
    }
    task.queue.push({ type: 'harness-event', event: safeEvent })
  } else if (event.type === 'notification') {
    task.queue.push({ type: 'harness-event', event: safeEvent })
  } else if (event.type === 'error') {
    task.error = redact(typeof event.error === 'string' ? event.error : JSON.stringify(safeEvent), task.secrets)
    task.errorEventSent = true
    task.queue.push({ type: 'error', message: task.error })
  } else if (event.type === 'complete') {
    task.completed = true
    task.queue.push({ type: 'harness-event', event: safeEvent })
  } else task.queue.push({ type: 'harness-event', event: safeEvent })
}

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (value.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${value.protocol}`)
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string') throw new TypeError('model profile baseUrl must be a string')
    const url = new URL(value.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) || value.model.length > 200 || value.id.length > 200) throw new TypeError('model profile id/model or apiKeyEnv is invalid')
  return { id: value.id.trim(), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), ...(value.baseUrl ? { baseUrl: value.baseUrl.replace(/\/$/, '') } : {}) }
}

function isolatedEnvironment(hostEnv = {}, profile, root) {
  const child = { ...process.env, ...hostEnv }
  for (const key of Object.keys(child)) if (/^(GOOSE_|OPENAI_)/i.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete child[key]
  delete child[profile.apiKeyEnv]
  const configDir = resolve(root, 'config', 'goose')
  const homeDir = resolve(root, 'home')
  const dataDir = resolve(root, 'data')
  const stateDir = resolve(root, 'state')
  const cacheDir = resolve(root, 'cache')
  child.HOME = homeDir
  child.XDG_CONFIG_HOME = resolve(root, 'config')
  child.XDG_DATA_HOME = dataDir
  child.XDG_STATE_HOME = stateDir
  child.XDG_CACHE_HOME = cacheDir
  child.GOOSE_CONFIG_DIR = configDir
  child.GOOSE_DISABLE_KEYRING = '1'
  child.GOOSE_PROVIDER = 'openai'
  child.GOOSE_MODEL = profile.model
  child.GOOSE_MODE = 'auto'
  child.GOOSE_TELEMETRY_ENABLED = 'false'
  child.OPENAI_API_KEY = hostEnv[profile.apiKeyEnv]
  child.OPENAI_HOST = profile.baseUrl ?? 'https://api.openai.com'
  const baseUrl = new URL(child.OPENAI_HOST)
  if (baseUrl.pathname.endsWith('/v1')) {
    child.OPENAI_HOST = `${baseUrl.origin}${baseUrl.pathname.slice(0, -3)}`
    child.OPENAI_BASE_PATH = 'v1/chat/completions'
  } else child.OPENAI_BASE_PATH = 'v1/chat/completions'
  return child
}

function rejectLegacyConfig(config) {
  for (const key of ['model', 'provider', 'baseUrl', 'baseURL']) if (Object.hasOwn(config, key)) throw new TypeError('model, provider, and base URL must come from the external model profile')
}
function profileFingerprint(profile) { return createHash('sha256').update(JSON.stringify(profile)).digest('hex') }
function gatherSecrets(env = {}, selectedKey) {
  const values = Object.entries(env)
    .filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value)
  if (typeof selectedKey === 'string') values.push(selectedKey)
  return [...new Set(values.filter(value => value.length >= 4))]
}
function redact(text, secrets) { return secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(text)) }
function redactDeep(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redactDeep(entry, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry, secrets)]))
  return value
}
function safeMessage(error) { return error instanceof Error ? error.message : String(error) }

async function readSessionMap(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('invalid Goose session map')
    return Object.assign(Object.create(null), parsed)
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.create(null)
    throw new Error(`Cannot read Goose session map: ${safeMessage(error)}`)
  }
}

async function assertPinnedRuntime(command) {
  let result
  try { result = await execFile(command, ['--version'], { timeout: 10_000, windowsHide: true }) }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Pinned Goose CLI v${PINNED_VERSION} is not installed at ${command}. Run the setup:runtime script: node packages/runtime/adapters/goose/scripts/setup-runtime.mjs --state-dir <stateDir>, or pass config.program/GOOSE_BIN to an existing pinned binary.`)
    throw new Error(`Could not verify Goose CLI at ${command}: ${safeMessage(error)}`)
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const escapedVersion = PINNED_VERSION.replaceAll('.', '\\.')
  if (!new RegExp(`(?:^|\\s)v?${escapedVersion}(?:$|\\s)`).test(output.trim())) {
    throw new Error(`Goose CLI at ${command} must report version ${PINNED_VERSION}; received ${output.trim().slice(0, 200) || '(no version output)'}`)
  }
}

function eventQueue() {
  const values = []; const waiters = []; let ended = false
  return {
    push(value) { if (ended) return; const waiter = waiters.shift(); waiter ? waiter({ value, done: false }) : values.push(value) },
    finish() { if (ended) return; ended = true; while (waiters.length) waiters.shift()({ value: undefined, done: true }) },
    next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiters.push(resolveNext)) },
  }
}
function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return } catch (error) { if (error.code === 'ESRCH') return }
  }
  try { child.kill(signal) } catch {}
}
function waitForClose(closePromise, ms) { return new Promise(resolveWait => { const timer = setTimeout(() => resolveWait(false), ms); closePromise.then(() => { clearTimeout(timer); resolveWait(true) }, () => { clearTimeout(timer); resolveWait(true) }) }) }
