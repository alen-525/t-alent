import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('../worker/openhands_worker.py', import.meta.url))
const API_KEY = 'TALENT_OPENHANDS_MODEL_API_KEY'

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  const baseEnv = { ...process.env, ...(env ?? {}) }
  const python = config.python ?? baseEnv.TALENT_OPENHANDS_PYTHON ?? resolve(stateDir, config.venvDir ?? 'openhands-runtime/venv', 'bin', 'python')
  return createAgentPackageWithRuntime({ workspace, stateDir, env: baseEnv, config }, { python, worker, spawnProcess: spawn })
}

/** Process seam for tests; production executes the pinned OpenHands SDK worker. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required')
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required')
  for (const key of Object.keys(config)) if (!['python', 'venvDir', 'cancelGraceMs'].includes(key)) throw new TypeError(`Unsupported OpenHands config: ${key}; model behavior belongs to the host profile`)
  const grace = config.cancelGraceMs ?? 5000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('cancelGraceMs must be between 1 and 60000')
  const root = resolve(workspace), state = resolve(stateDir)
  const venv = resolve(config.venvDir ?? resolve(state, 'openhands-runtime', 'venv'))
  const python = resolve(runtime.python ?? config.python ?? resolve(venv, 'bin', 'python'))
  await mkdir(resolve(state, 'conversations'), { recursive: true, mode: 0o700 })
  const environment = { ...process.env, ...(env ?? {}) }
  let active, disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('OpenHands package is disposed')
    if (active) throw new Error(`OpenHands package already has active task ${active.taskId}`)
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and non-empty input are required')
    const profile = validateProfile(model)
    const credential = environment[profile.apiKeyEnv]
    if (typeof credential !== 'string' || !credential) throw new TypeError(`Model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const fingerprint = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    const conversationKey = createHash('sha256').update(`${String(sessionId || taskId)}\0${fingerprint}`).digest('hex')
    const conversationId = digestUuid(conversationKey)
    const secrets = [...new Set([credential, ...Object.entries(environment).filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof value === 'string' && value.length >= 4).map(([, value]) => value)])]
    const taskHome = resolve(state, 'homes', fingerprint)
    const taskEnv = { ...environment }
    for (const name of Object.keys(taskEnv)) if (/^(OPENHANDS|LITELLM|OPENAI)_/i.test(name) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name === 'NODE_OPTIONS') delete taskEnv[name]
    taskEnv[API_KEY] = credential
    taskEnv.HOME = taskHome
    taskEnv.OPENHANDS_SUPPRESS_BANNER = '1'
    taskEnv.PYTHONUNBUFFERED = '1'
    const task = { taskId, profile, credential, secrets, input, conversationId, persistenceDir: resolve(state, 'conversations', fingerprint), taskEnv, cancelGraceMs: grace, signal, queue: eventQueue(), child: null, closed: false, cancelling: !!signal?.aborted, settled: false, parseError: null }
    active = task
    task.finished = Promise.resolve().then(() => run(task))
    task.abortListener = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abortListener, { once: true })
    return { async *[Symbol.asyncIterator]() { try { for (;;) { const next = await task.queue.next(); if (next.done) return; yield next.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }

  async function run(task) {
    let stdout = '', stderr = ''
    try {
      await mkdir(task.persistenceDir, { recursive: true, mode: 0o700 })
      await mkdir(taskEnvHome(task), { recursive: true, mode: 0o700 })
      if (task.cancelling || task.signal?.aborted) return
      await runtime.beforeSpawn?.()
      if (task.cancelling || task.signal?.aborted) return
      const child = runtime.spawnProcess(python, [...(runtime.pythonArgs ?? ['-u']), runtime.worker ?? worker], { cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      task.child = child
      task.closePromise = new Promise(resolveClose => { child.once('error', error => { task.spawnError = error }); child.once('close', (code, sig) => { task.closed = true; resolveClose({ code, sig }) }) })
      child.stdin.on('error', error => { task.stdinError = error })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
        let index
        while ((index = stdout.indexOf('\n')) >= 0) { const line = stdout.slice(0, index); stdout = stdout.slice(index + 1); if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) task.parseError ??= new Error('OpenHands worker emitted an NDJSON line larger than 4 MiB'); else acceptLine(task, line); if (task.parseError) { void terminateChild(task, child); return } }
        if (Buffer.byteLength(stdout, 'utf8') > 4 * 1024 * 1024) { task.parseError ??= new Error('OpenHands worker emitted an NDJSON line larger than 4 MiB'); void terminateChild(task, child) }
      })
      child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { if (stderr.length < 16000) stderr += chunk.slice(0, 16000 - stderr.length) })
      const request = { workspace: root, persistenceDir: task.persistenceDir, conversationId: task.conversationId, input: task.input, model: task.profile }
      try { child.stdin.write(`${JSON.stringify(request)}\n`) } catch (error) { task.stdinError = error }
      if (task.cancelling) { try { child.stdin.write('{"type":"cancel"}\n') } catch (error) { task.stdinError ??= error } }
      const outcome = await task.closePromise
      if (stdout.trim() && !task.cancelling) acceptLine(task, stdout)
      if (task.cancelling || task.signal?.aborted) return
      if (task.spawnError) throw task.spawnError
      if (task.stdinError) throw task.stdinError
      if (task.parseError) throw task.parseError
      if (task.workerError) throw new Error(task.workerError)
      if (outcome.code !== 0) throw new Error(stderr.trim() || `OpenHands worker exited with code ${outcome.code}`)
      if (!task.doneStatus) throw new Error('OpenHands worker exited without a terminal status')
      if (task.doneStatus === 'finished') { task.queue.push({ type: 'assistant-complete' }) }
      else throw new Error(`OpenHands conversation ended with status ${task.doneStatus}`)
    } catch (error) {
      if (task.child && !task.closed) await terminateChild(task, task.child)
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(error?.message || String(error), task.secrets) })
    } finally {
      task.signal?.removeEventListener('abort', task.abortListener)
      task.settled = true
      if (task.cancelling) task.queue.push({ type: 'cancelled' })
      task.queue.finish()
      if (active === task) active = null
    }
  }

  function acceptLine(task, line) {
    if (!line.trim() || task.cancelling) return
    let record
    try { record = JSON.parse(line) } catch { task.parseError ??= new Error('OpenHands worker emitted malformed NDJSON'); return }
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.kind !== 'string') { task.parseError ??= new Error('OpenHands worker emitted an invalid NDJSON record'); return }
    if (record.kind === 'session' && typeof record.sessionId === 'string') task.queue.push({ type: 'session', sessionId: redact(record.sessionId, task.secrets) })
    else if (record.kind === 'assistant-delta' && typeof record.text === 'string') task.queue.push({ type: 'assistant-delta', text: redact(record.text, task.secrets) })
    else if (record.kind === 'tool-call') task.queue.push({ type: 'tool-call', name: redact(record.name ?? 'tool', task.secrets), callId: redact(record.callId ?? '', task.secrets), input: redactDeep(record.input, task.secrets) })
    else if (record.kind === 'tool-result') task.queue.push({ type: 'tool-result', name: redact(record.name ?? 'tool', task.secrets), callId: redact(record.callId ?? '', task.secrets), status: record.status === 'error' ? 'error' : 'success', output: redactDeep(record.output ?? '', task.secrets) })
    else if (record.kind === 'harness-event') task.queue.push({ type: 'harness-event', event: redactDeep(record.event, task.secrets) })
    else if (record.kind === 'error') task.workerError = redact(record.message ?? 'OpenHands reported an error', task.secrets)
    else if (record.kind === 'done' && typeof record.status === 'string') task.doneStatus = record.status
    else task.parseError ??= new Error(`OpenHands worker emitted an unknown record kind: ${record.kind}`)
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      const child = task.child
      if (child && !task.closed) {
        try { child.stdin.write('{"type":"cancel"}\n') } catch {}
        const stopped = await waitClose(task.closePromise, grace)
        if (!stopped) { kill(child, 'SIGKILL'); await task.closePromise }
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
  if (profile.baseUrl !== undefined) { let url; try { url = new URL(profile.baseUrl) } catch { throw new TypeError('model profile baseUrl must be a valid HTTP(S) URL') }; if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL') }
  return { id: profile.id, provider: profile.provider, model: profile.model, protocol: profile.protocol, apiKeyEnv: profile.apiKeyEnv, ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }), ...(typeof profile.name === 'string' ? { name: profile.name } : {}) }
}
function digestUuid(hex) { const b = Buffer.from(hex.slice(0, 32), 'hex'); b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80; const s = b.toString('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}` }
function taskEnvHome(task) { return resolve(task.taskEnv.HOME) }
function redact(text, secrets) { let value = String(text); for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value }
function redactDeep(value, secrets) { if (typeof value === 'string') return redact(value, secrets); if (Array.isArray(value)) return value.map(item => redactDeep(item, secrets)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)])) }
function kill(child, signal) { if (process.platform === 'win32' || !child.pid) child.kill(signal); else { try { process.kill(-child.pid, signal) } catch (error) { if (error?.code !== 'ESRCH') child.kill(signal) } } }
function eventQueue() { const items = []; let wake, finished = false; return { push(item) { items.push(item); wake?.(); wake = null }, finish() { finished = true; wake?.(); wake = null }, async next() { while (!items.length && !finished) await new Promise(resolve => { wake = resolve }); return items.length ? { value: items.shift(), done: false } : { done: true } } } }
async function waitClose(promise, ms) { let timer; return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })]).finally(() => clearTimeout(timer)) }
function terminateChild(task, child) { task.terminatePromise ??= (async () => { if (task.closed) return; kill(child, 'SIGTERM'); const stopped = await waitClose(task.closePromise, task.cancelGraceMs ?? 5000); if (!stopped && !task.closed) { kill(child, 'SIGKILL'); await task.closePromise } })(); return task.terminatePromise }
