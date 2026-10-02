import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const sessionMapName = 'deepseek-sessions.json'
const defaultCancelGraceMs = 7_000

/** Create one original DeepSeek Harness headless runner. */
export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, {
    command: process.execPath,
    bin: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js')),
    spawnProcess: spawn,
  })
}

/** Runtime injection used by package tests; production always calls the official dsh binary. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || workspace.length === 0) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || stateDir.length === 0) throw new TypeError('stateDir is required')
  const root = resolve(workspace)
  const state = resolve(stateDir)
  const home = resolve(state, 'dsh')
  await Promise.all([mkdir(state, { recursive: true }), mkdir(home, { recursive: true })])

  const environment = { ...process.env, ...(env ?? {}) }
  const configuredModel = config.model ?? environment.DEEPSEEK_MODEL
  environment.DSH_HOME = home
  const cancelGraceMs = Number.isSafeInteger(config.cancelGraceMs) && config.cancelGraceMs > 0
    ? Math.min(config.cancelGraceMs, 60_000)
    : defaultCancelGraceMs
  const sessionsPath = resolve(state, sessionMapName)
  const sessions = await readSessionMap(sessionsPath)
  let active = null
  let disposed = false

  async function listModels() {
    if (disposed) throw new Error('DeepSeek agent package is disposed')
    const { deepSeekConfigFields } = await import('@deepseek-ai/dsh-llm-deepseek')
    const models = deepSeekConfigFields.models.meta.default.map(({ id, name, description }) => ({
      id,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }))
    const result = { models, allowCustomModel: true }
    // Caller patches are applied after the package model overlay and may change
    // the actual default route. Do not publish a default that may be stale.
    if (!Array.isArray(config.patches) || config.patches.length === 0) {
      result.defaultModel = configuredModel === undefined
        ? await readPackageDefaultModel()
        : validateModel(configuredModel, 'configured model')
    }
    return result
  }

  async function persistSessions() {
    const temporary = `${sessionsPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(sessions), { mode: 0o600 })
    await rename(temporary, sessionsPath)
  }

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('DeepSeek agent package is disposed')
    if (active) throw new Error(`DeepSeek agent package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const selectedModel = model === undefined
      ? configuredModel === undefined ? undefined : validateModel(configuredModel, 'configured model')
      : validateModel(model, 'task model')

    const conversationKey = String(sessionId || taskId)
    const queue = eventQueue()
    const task = {
      taskId,
      model: selectedModel,
      explicitlySelectedModel: model !== undefined,
      conversationKey,
      queue,
      child: null,
      childReady: null,
      signalChildReady: null,
      closePromise: null,
      settled: false,
      cancelling: false,
      cancelPromise: null,
      cancelEventSent: false,
      signal,
      abortListener: null,
      pendingPersist: Promise.resolve(),
      persistenceError: null,
      toolNames: new Map(),
      overlayPath: null,
      selectionOverlayPath: null,
      secrets: Object.entries(environment)
        .filter(([key, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 4)
        .map(([, value]) => value),
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
            const next = await queue.next()
            if (next.done) return
            yield next.value
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
      const child = task.child
      if (child && !task.closed) {
        child.kill('SIGINT')
        const closed = await waitForClose(task.closePromise, cancelGraceMs)
        if (!closed) {
          child.kill('SIGKILL')
          await task.closePromise
        }
      }
      await task.finished
    })()
    await task.cancelPromise
  }

  async function run(task, input) {
    let sawFinal = false
    let finalText = ''
    let sawError = null
    let endReason
    let stdoutBuffer = ''
    let stderrBuffer = ''
    try {
      const upstreamSessionId = sessions[task.conversationKey]
      const model = task.model ?? await readPackageDefaultModel()
      const modelOverlay = await writeModelOverlay({ state, taskId: task.taskId, config, model })
      task.overlayPath = modelOverlay
      const customPatches = Array.isArray(config.patches) ? config.patches : []
      const args = [
        '--profile', 'headless',
        '--patch', resolve(packageDir, '../cordis.patch.yml'),
        '--patch', modelOverlay,
        ...customPatches.flatMap(path => ['--patch', resolve(root, path)]),
        ...(task.explicitlySelectedModel ? ['--patch', task.selectionOverlayPath = await writeModelSelectionOverlay({ state, taskId: task.taskId, model: task.model })] : []),
        '--json',
        ...(upstreamSessionId ? ['--session-id', upstreamSessionId] : []),
        '-',
      ]
      await runtime.beforeSpawn?.()
      const child = runtime.spawnProcess(runtime.command, [runtime.bin, ...args], {
        cwd: root,
        env: environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
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
          acceptJsonLine(task, line, {
            onSession: id => {
              sessions[task.conversationKey] = id
              task.pendingPersist = task.pendingPersist.then(persistSessions).catch(error => { task.persistenceError = error })
            },
            onFinal: text => { sawFinal = true; finalText = text },
            onError: message => { sawError = message },
            onTurnEnd: reason => { endReason = reason },
          })
        }
      })
      child.stderr.on('data', chunk => {
        if (stderrBuffer.length < 8 * 1024) stderrBuffer += String(chunk).slice(0, 8 * 1024 - stderrBuffer.length)
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)

      const outcome = await task.closePromise
      if (stdoutBuffer.trim() && !task.cancelling) {
        acceptJsonLine(task, stdoutBuffer, {
          onSession: id => {
            sessions[task.conversationKey] = id
            task.pendingPersist = task.pendingPersist.then(persistSessions).catch(error => { task.persistenceError = error })
          },
          onFinal: text => { sawFinal = true; finalText = text },
          onError: message => { sawError = message },
          onTurnEnd: reason => { endReason = reason },
        })
      }
      await task.pendingPersist
      if (task.persistenceError) throw task.persistenceError
      if (task.cancelling || task.signal?.aborted) return
      if (outcome.code !== 0 || sawError || !sawFinal || endReason?.kind !== 'completed') {
        throw new Error(sawError ?? turnFailure(endReason, outcome, redactText(stderrBuffer, task.secrets)))
      }
      task.queue.push({ type: 'assistant-replace', text: finalText })
      task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) {
        task.child.kill('SIGTERM')
        await task.closePromise?.catch(() => {})
      }
      if (!task.cancelling && !task.signal?.aborted) {
        task.queue.push({ type: 'error', message: redactText(safeErrorMessage(error), task.secrets) })
      }
    } finally {
      task.signalChildReady?.()
      if (task.overlayPath) await rm(task.overlayPath, { force: true }).catch(() => {})
      if (task.selectionOverlayPath) await rm(task.selectionOverlayPath, { force: true }).catch(() => {})
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

  return { listModels, executeTask, cancelTask, dispose }
}

function acceptJsonLine(task, line, callbacks) {
  if (task.cancelling || !line.trim()) return
  let event
  try { event = JSON.parse(line) }
  catch { callbacks.onError(redactText(`DeepSeek Harness emitted invalid JSON: ${line.slice(0, 400)}`, task.secrets)); return }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
    callbacks.onError('DeepSeek Harness emitted a malformed JSON event')
    return
  }
  event = redactDeep(event, task.secrets)
  switch (event.type) {
    case 'session':
      if (typeof event.sessionId !== 'string' || !event.sessionId) { callbacks.onError('DeepSeek Harness session event omitted sessionId'); return }
      callbacks.onSession(event.sessionId)
      task.queue.push({ type: 'session', sessionId: event.sessionId })
      return
    case 'text':
      if (typeof event.text !== 'string') { callbacks.onError('DeepSeek Harness text event omitted text'); return }
      task.queue.push({ type: 'assistant-delta', text: event.text ?? '' })
      return
    case 'thinking':
      if (typeof event.text !== 'string') { callbacks.onError('DeepSeek Harness thinking event omitted text'); return }
      task.queue.push({ type: 'reasoning', text: event.text ?? '' })
      return
    case 'tool_call':
      if (typeof event.callId !== 'string' || typeof event.tool !== 'string') { callbacks.onError('DeepSeek Harness tool_call event omitted callId or tool'); return }
      if (typeof event.callId === 'string' && typeof event.tool === 'string') task.toolNames.set(event.callId, event.tool)
      task.queue.push({ type: 'tool-call', name: event.tool, input: event.input, callId: event.callId })
      return
    case 'tool_result':
      if (typeof event.callId !== 'string' || typeof event.result !== 'string' || typeof event.status !== 'string') { callbacks.onError('DeepSeek Harness tool_result event is malformed'); return }
      task.queue.push({ type: 'tool-result', name: task.toolNames.get(event.callId), output: event.result, status: event.status, callId: event.callId })
      return
    case 'status':
      if (typeof event.phase !== 'string') { callbacks.onError('DeepSeek Harness status event omitted phase'); return }
      if (event.phase === 'turn_end') callbacks.onTurnEnd(event.reason)
      task.queue.push({ type: 'harness-event', event })
      return
    case 'final':
      if (typeof event.text !== 'string') { callbacks.onError('DeepSeek Harness final event omitted text'); return }
      callbacks.onFinal(event.text)
      return
    case 'error':
      if (typeof event.message !== 'string') { callbacks.onError('DeepSeek Harness error event omitted message'); return }
      callbacks.onError(event.message)
      return
    default:
      task.queue.push({ type: 'harness-event', event })
  }
}

async function writeModelOverlay({ state, taskId, config, model }) {
  const provider = 'deepseek-official'
  const agentConfig = { provider, model }
  if (config.reasoningEffort !== undefined) agentConfig.reasoningEffort = config.reasoningEffort
  const providerConfig = {}
  if (config.reasoningEffort !== undefined) providerConfig.reasoningEffort = config.reasoningEffort
  if (config.maxTokens !== undefined) providerConfig.maxTokens = config.maxTokens
  const content = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: agentConfig },
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: providerConfig },
  ]
  const serialized = JSON.stringify(content, null, 2)
  const target = resolve(state, `deepseek-${safeFilePart(taskId)}-${randomUUID()}.patch.yml`)
  await writeFile(target, serialized, { mode: 0o600 })
  return target
}

async function writeModelSelectionOverlay({ state, taskId, model }) {
  const content = [{
    id: 'agent-default-model',
    name: '@deepseek-ai/dsh-agent-default-model',
    config: { provider: 'deepseek-official', model },
  }]
  const target = resolve(state, `deepseek-${safeFilePart(taskId)}-selection-${randomUUID()}.patch.yml`)
  await writeFile(target, JSON.stringify(content, null, 2), { mode: 0o600 })
  return target
}

function validateModel(value, source) {
  if (typeof value !== 'string') throw new TypeError(`${source} must be a string`)
  const model = value.trim()
  if (model.length < 1 || model.length > 200) throw new TypeError(`${source} must contain 1–200 characters`)
  return model
}

async function readPackageDefaultModel() {
  const basePatch = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')), 'utf8')
  const row = basePatch.match(/(?:^|\n)\s*- id: agent-default-model\b([\s\S]*?)(?=\n\s*- id:|\s*$)/)?.[1]
  const model = row?.match(/\n\s+model:\s*([^\s#]+)/)?.[1]
  if (!model) throw new Error('Official DSH base package does not declare an agent default model')
  return model
}

async function readSessionMap(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid session map')
    for (const [key, sessionId] of Object.entries(value)) {
      if (typeof sessionId !== 'string' || !sessionId) throw new Error(`invalid upstream Session id for ${JSON.stringify(key)}`)
    }
    return Object.assign(Object.create(null), value)
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.create(null)
    throw new Error(`Cannot read DeepSeek session map: ${safeErrorMessage(error)}`)
  }
}

function eventQueue() {
  const values = []
  const waiting = []
  let ended = false
  return {
    push(value) {
      if (ended) return
      const waiter = waiting.shift()
      if (waiter) waiter({ value, done: false })
      else values.push(value)
    },
    finish() {
      if (ended) return
      ended = true
      while (waiting.length) waiting.shift()({ value: undefined, done: true })
    },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false })
      if (ended) return Promise.resolve({ value: undefined, done: true })
      return new Promise(resolveNext => waiting.push(resolveNext))
    },
  }
}

function safeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'task'
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function turnFailure(reason, outcome, diagnostic) {
  if (outcome.error) return safeErrorMessage(outcome.error)
  if (reason?.kind === 'error') {
    const failure = reason.error ?? reason.failure
    const message = failure?.message ?? reason.message
    if (typeof message === 'string' && typeof failure?.code === 'string') return `${failure.code}: ${message}`
    if (typeof message === 'string') return message
    return diagnostic?.trim() ? diagnostic.trim().slice(-8 * 1024) : 'DeepSeek Harness turn failed'
  }
  if (reason?.kind === 'aborted') return `DeepSeek Harness turn aborted (${reason.reason?.kind ?? 'unknown'})`
  if (outcome.signal) return `DeepSeek Harness exited on ${outcome.signal}`
  if (diagnostic?.trim()) return diagnostic.trim().slice(-8 * 1024)
  return `DeepSeek Harness exited with code ${String(outcome.code)} without a completed final event`
}

function redactText(value, secrets) {
  return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
}

function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]))
  }
  return value
}

function waitForClose(closePromise, milliseconds) {
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => resolveClose(false), milliseconds)
    closePromise.then(() => {
      clearTimeout(timer)
      resolveClose(true)
    }, error => {
      clearTimeout(timer)
      rejectClose(error)
    })
  })
}
