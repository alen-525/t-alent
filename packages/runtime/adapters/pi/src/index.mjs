import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent'

const supportedApis = {
  'openai-chat-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  anthropic: 'anthropic-messages',
  'google-generative-ai': 'google-generative-ai',
}
const defaultBaseUrls = {
  'openai-chat-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
}

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace) throw new TypeError('workspace is required')
  if (!stateDir) throw new TypeError('stateDir is required')
  rejectLegacyModelConfig(config)
  const root = resolve(workspace)
  const state = resolve(stateDir)
  const piState = resolve(state, 'pi')
  await mkdir(resolve(piState, 'sessions'), { recursive: true })
  const sessionsPath = resolve(piState, 'host-sessions.json')
  const sessions = await readSessionMap(sessionsPath)
  const environment = { ...process.env, ...(env ?? {}) }
  let active
  let disposed = false

  async function persistSessions() {
    const temp = `${sessionsPath}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(sessions), { mode: 0o600 })
    await rename(temp, sessionsPath)
  }

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Pi agent package is disposed')
    if (active) throw new Error(`Pi agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const profile = validateProfile(model)
    const apiKey = environment[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const key = `${String(sessionId || taskId)}\0${fingerprint(profile)}`
    const secrets = [...new Set([apiKey, ...Object.entries(environment)
      .filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4)
      .map(([, value]) => value)])]
    const task = { taskId, profile, apiKey, key, secrets, signal, cancelling: !!signal?.aborted, session: null, cancelPromise: null, finished: null, queue: eventQueue(), abortListener: null, settled: false }
    active = task
    task.finished = run(task, input)
    task.abortListener = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abortListener()
    else signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() {
      try { while (true) { const item = await task.queue.next(); if (item.done) return; yield item.value } }
      finally { if (!task.settled) await cancelTask(taskId) }
    } }
  }

  async function run(task, input) {
    let session
    let unsubscribe
    try {
      if (task.cancelling || task.signal?.aborted) return
      const authStorage = AuthStorage.inMemory()
      const piProvider = `t-alent-${fingerprint(task.profile).slice(0, 32)}`
      authStorage.setRuntimeApiKey(piProvider, task.apiKey)
      const modelRegistry = ModelRegistry.inMemory(authStorage)
      modelRegistry.registerProvider(piProvider, {
        name: task.profile.provider,
        api: supportedApis[task.profile.protocol],
        baseUrl: task.profile.baseUrl ?? defaultBaseUrls[task.profile.protocol],
        apiKey: task.profile.apiKeyEnv,
        authHeader: true,
        models: [{ id: task.profile.model, name: task.profile.model, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
      })
      const piModel = modelRegistry.find(piProvider, task.profile.model)
      if (!piModel) throw new Error('Pi could not resolve the selected model profile')
      const sessionPath = sessions[task.key]
      const sessionManager = sessionPath
        ? SessionManager.open(sessionPath, resolve(piState, 'sessions'), root)
        : SessionManager.create(root, resolve(piState, 'sessions'))
      const { session: agentSession } = await createAgentSession({
        cwd: root,
        agentDir: resolve(piState, 'agent'),
        authStorage,
        modelRegistry,
        model: piModel,
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
      })
      session = task.session = agentSession
      const actualSessionPath = session.sessionManager.getSessionFile()
      if (actualSessionPath && sessions[task.key] !== actualSessionPath) {
        sessions[task.key] = actualSessionPath
        await persistSessions()
      }
      task.queue.push({ type: 'session', sessionId: session.sessionManager.getSessionId() })
      unsubscribe = session.subscribe(event => mapEvent(task, event))
      if (task.cancelling || task.signal?.aborted) {
        await session.abort()
      } else {
        await session.prompt(input)
        const latest = session.messages.at(-1)
        if (session.state.errorMessage || (latest?.role === 'assistant' && ['error', 'aborted'].includes(latest.stopReason))) {
          throw new Error(session.state.errorMessage ?? latest.errorMessage ?? `Pi assistant turn ended with ${latest.stopReason}`)
        }
      }
      if (!task.signal?.aborted && !task.cancelling) {
        const text = redact(lastAssistantText(session), task.secrets)
        task.queue.push({ type: 'assistant-replace', text })
        task.queue.push({ type: 'assistant-complete' })
      }
    } catch (error) {
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(safeError(error), task.secrets) })
    } finally {
      unsubscribe?.()
      session?.dispose()
      if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelling && !task.cancelEventSent) { task.cancelEventSent = true; task.queue.push({ type: 'cancelled' }) }
      task.queue.finish()
      if (active === task) active = null
    }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      await task.session?.abort()
      await task.finished
    })()
    await task.cancelPromise
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    if (active) await cancelTask(active.taskId)
  }

  return { executeTask, cancelTask, dispose }
}

function mapEvent(task, event) {
  if (task.cancelling || task.signal?.aborted) return
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent
    if (update?.type === 'text_delta' && typeof update.delta === 'string') task.queue.push({ type: 'assistant-delta', text: redact(update.delta, task.secrets) })
    else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') task.queue.push({ type: 'reasoning', text: redact(update.delta, task.secrets) })
  } else if (event.type === 'tool_execution_start') {
    task.queue.push({ type: 'tool-call', name: redact(event.toolName, task.secrets), input: redactDeep(event.args, task.secrets), callId: redact(event.toolCallId, task.secrets) })
  } else if (event.type === 'tool_execution_end') {
    task.queue.push({ type: 'tool-result', name: redact(event.toolName, task.secrets), output: redact(event.result?.content?.map(part => part.text ?? '').join('') ?? '', task.secrets), status: event.isError ? 'error' : 'success', callId: redact(event.toolCallId, task.secrets) })
  }
}

function lastAssistantText(session) {
  const messages = session.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'assistant') return extractMessageText(messages[i])
  return session.getLastAssistantText?.() ?? ''
}
function extractMessageText(message) {
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
}

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('model profile is required')
  for (const key of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new TypeError(`model profile ${key} is required`)
  if (!Object.hasOwn(supportedApis, value.protocol)) throw new TypeError(`unsupported model profile protocol: ${value.protocol}`)
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string') throw new TypeError('model profile baseUrl must be a string')
    const url = new URL(value.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (value.id.length > 200 || value.model.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv)) throw new TypeError('model profile id/model or apiKeyEnv is invalid')
  return { id: value.id.trim(), provider: value.provider.trim(), model: value.model.trim(), protocol: value.protocol, apiKeyEnv: value.apiKeyEnv.trim(), ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}) }
}

function rejectLegacyModelConfig(config) {
  for (const name of ['model', 'provider', 'baseUrl', 'baseURL', 'apiKey', 'apiKeyEnv']) if (Object.hasOwn(config, name)) throw new TypeError(`${name} must come from the external model profile`)
}
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function safeError(error) { return error instanceof Error ? error.message : String(error) }
function redact(value, secrets) { return secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), value) }
function redactDeep(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]))
  return value
}
async function readSessionMap(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error('invalid session map')
    return value
  } catch (error) { if (error?.code === 'ENOENT') return Object.create(null); throw new Error(`Cannot read Pi session map: ${safeError(error)}`) }
}
function eventQueue() {
  const values = []; const waiting = []; let ended = false
  return {
    push(value) { if (ended) return; const waiter = waiting.shift(); if (waiter) waiter({ value, done: false }); else values.push(value) },
    finish() { if (ended) return; ended = true; while (waiting.length) waiting.shift()({ value: undefined, done: true }) },
    next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise(resolveNext => waiting.push(resolveNext)) },
  }
}
