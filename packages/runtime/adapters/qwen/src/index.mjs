import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')

export async function createAgentPackage(options) {
  const manifest = require.resolve('@qwen-code/qwen-code/package.json')
  const manifestJson = JSON.parse(await readFile(manifest, 'utf8'))
  const entry = manifestJson.bin?.['qwen'] ?? manifestJson.bin
  if (!entry || typeof entry !== 'string') throw new Error('Pinned Qwen Code package has no qwen CLI entry')
  return createAgentPackageWithRuntime(options, { command: process.execPath, bin: resolve(dirname(manifest), entry), spawnProcess: spawn })
}

/** The production adapter runs the pinned upstream CLI; tests inject only the process boundary. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  for (const key of Object.keys(config)) if (key !== 'cancelGraceMs') throw new TypeError(`Unsupported Qwen behavior config: ${key}; models come from the host profile`)
  const grace = config.cancelGraceMs ?? 5000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('Invalid cancelGraceMs')
  const root = resolve(workspace), state = resolve(stateDir)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const baseEnv = { ...process.env, ...(env ?? {}) }
  const sessionsPath = resolve(state, 'qwen-sessions.json')
  const sessions = await readMap(sessionsPath)
  let active, disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Qwen package is disposed')
    if (active) throw new Error('Qwen package already has an active task')
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and input are required')
    const profile = validateProfile(model)
    const key = baseEnv[profile.apiKeyEnv]
    if (typeof key !== 'string' || !key) throw new TypeError(`Missing model API key environment variable ${profile.apiKeyEnv}`)
    const fingerprint = hash(JSON.stringify(profile))
    const conversationKey = hash(`${sessionId || taskId}\0${fingerprint}`)
    const secrets = [...new Set([key, ...Object.entries(baseEnv).filter(([k,v]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)])]
    const home = resolve(state, 'homes', fingerprint)
    const taskEnv = { ...baseEnv, HOME: home, OPENAI_API_KEY: key, OPENAI_BASE_URL: profile.baseUrl ?? 'https://api.openai.com/v1' }
    for (const name of Object.keys(taskEnv)) if (/^(QWEN|GEMINI|OPENAI)_/i.test(name) || (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && name !== profile.apiKeyEnv) || name === 'NODE_OPTIONS') delete taskEnv[name]
    taskEnv.OPENAI_API_KEY = key
    taskEnv.OPENAI_BASE_URL = profile.baseUrl ?? 'https://api.openai.com/v1'
    const task = { taskId, profile, key, fingerprint, conversationKey, home, taskEnv, secrets, signal, queue: eventQueue(), child: null, closed: false, cancelling: !!signal?.aborted, settled: false, persistPromise: Promise.resolve() }
    active = task
    task.finished = Promise.resolve().then(() => run(task, input))
    task.abort = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abort, { once: true })
    return { async *[Symbol.asyncIterator]() { try { for (;;) { const next = await task.queue.next(); if (next.done) return; yield next.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }

  async function saveSession(task, id) {
    if (!id || sessions[task.conversationKey] === id) return
    sessions[task.conversationKey] = id
    const tmp = `${sessionsPath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 }); await rename(tmp, sessionsPath)
  }

  async function run(task, input) {
    let stdout = '', stderr = '', finalText = '', sawText = false, sawSuccessfulResult = false, parseError, persistenceError
    const seenTools = new Map()
    const accept = line => {
      if (!line.trim() || task.cancelling) return
      try {
        const e = JSON.parse(line)
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string' || !['system', 'assistant', 'user', 'result', 'stream_event', 'control_request', 'control_response', 'message'].includes(e.type)) throw new Error('Qwen Code emitted an unknown or malformed stream event')
        const id = e.session_id ?? e.sessionId
        if (id && id !== task.knownSession) { task.knownSession = id; task.queue.push({ type: 'session', sessionId: redact(id, task.secrets) }); task.persistPromise = task.persistPromise.then(() => saveSession(task, id)).catch(error => { persistenceError = error }) }
        if (e.type === 'assistant' || e.type === 'message' && (e.role === 'assistant' || e.message?.role === 'assistant')) {
          const blocks = e.message?.content ?? e.content
          if (typeof blocks === 'string') { sawText = true; finalText = blocks; task.queue.push({ type: 'assistant-delta', text: redact(blocks, task.secrets) }) }
          else if (Array.isArray(blocks)) for (const block of blocks) {
            if (block?.type === 'text' && typeof block.text === 'string') { sawText = true; finalText += block.text; task.queue.push({ type: 'assistant-delta', text: redact(block.text, task.secrets) }) }
            else if (block?.type === 'tool_use') { seenTools.set(block.id, redact(block.name ?? 'tool', task.secrets)); task.queue.push({ type: 'tool-call', name: redact(block.name ?? 'tool', task.secrets), callId: redact(block.id ?? '', task.secrets), input: redactDeep(block.input ?? {}, task.secrets) }) }
            else if (block?.type === 'thinking') task.queue.push({ type: 'harness-event', event: redactDeep(block, task.secrets) })
            else throw new Error('Qwen Code emitted an unknown assistant content block')
          }
          else throw new Error('Qwen Code emitted an assistant event without content')
        } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
          for (const block of e.message.content) {
            if (block?.type === 'tool_result') task.queue.push({ type: 'tool-result', name: redact(seenTools.get(block.tool_use_id) ?? 'tool', task.secrets), callId: redact(block.tool_use_id ?? '', task.secrets), status: block.is_error ? 'error' : 'success', output: redactDeep(block.content ?? '', task.secrets) })
            else if (block?.type !== 'text') throw new Error('Qwen Code emitted an unknown user content block')
          }
        } else if (e.type === 'result') {
          if (e.is_error) parseError = new Error(redact(e.error?.message ?? e.result ?? 'Qwen Code reported an error', task.secrets))
          else if (e.is_error === false && e.subtype === 'success') sawSuccessfulResult = true
        } else task.queue.push({ type: 'harness-event', event: redactDeep(e, task.secrets) })
      } catch (error) { parseError ??= new Error(error instanceof SyntaxError ? 'Qwen Code emitted malformed stream JSON' : redact(error.message, task.secrets)) }
    }
    try {
      await mkdir(task.home, { recursive: true, mode: 0o700 })
      if (task.cancelling || task.signal?.aborted) return
      await runtime.beforeSpawn?.()
      if (task.cancelling || task.signal?.aborted) return
      const prior = sessions[task.conversationKey]
      const args = ['--bare', '--prompt', input, '--output-format', 'stream-json', '--auth-type', 'openai', '--model', task.profile.model, ...(prior ? ['--resume', prior] : [])]
      const child = runtime.spawnProcess(runtime.command ?? process.execPath, [...(runtime.bin ? [runtime.bin] : []), ...args], { cwd: root, env: task.taskEnv, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      task.child = child
      task.closePromise = new Promise(resolveClose => { child.once('error', error => { task.spawnError = error }); child.once('close', (code, sig) => { task.closed = true; resolveClose({ code, sig }) }) })
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
        stdout += chunk
        let i
        while ((i = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, i); stdout = stdout.slice(i + 1)
          if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) { parseError ??= new Error('Qwen Code stream line exceeded 4 MiB'); kill(child, 'SIGTERM'); return }
          accept(line)
          if (parseError) { kill(child, 'SIGTERM'); return }
        }
        if (Buffer.byteLength(stdout, 'utf8') > 4 * 1024 * 1024) { parseError ??= new Error('Qwen Code stream line exceeded 4 MiB'); kill(child, 'SIGTERM') }
      })
      child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk.slice(0, 12000 - stderr.length) })
      const outcome = await task.closePromise
      if (stdout.trim() && !task.cancelling) {
        if (Buffer.byteLength(stdout, 'utf8') > 4 * 1024 * 1024) parseError ??= new Error('Qwen Code stream line exceeded 4 MiB')
        else accept(stdout)
      }
      if (task.cancelling || task.signal?.aborted) return
      await task.persistPromise
      if (task.spawnError) throw task.spawnError
      if (persistenceError) throw persistenceError
      if (parseError) throw parseError
      if (outcome.code !== 0 || !sawText || !sawSuccessfulResult) throw new Error(redact(stderr.trim() || `Qwen Code exited with code ${outcome.code ?? 'unknown'} without a successful result`, task.secrets))
      task.queue.push({ type: 'assistant-replace', text: redact(finalText, task.secrets) }); task.queue.push({ type: 'assistant-complete' })
    } catch (error) {
      if (task.child && !task.closed) { kill(task.child, 'SIGTERM'); await task.closePromise?.catch(() => {}) }
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({ type: 'error', message: redact(error?.message || String(error), task.secrets) })
    } finally {
      task.signal?.removeEventListener('abort', task.abort)
      task.settled = true
      if (task.cancelling) task.queue.push({ type: 'cancelled' })
      task.queue.finish(); if (active === task) active = null
    }
  }

  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => { task.cancelling = true; if (task.child && !task.closed) { kill(task.child, 'SIGINT'); await waitClose(task.closePromise, grace); kill(task.child, 'SIGKILL'); await task.closePromise }; await task.finished })()
    await task.cancelPromise
  }
  async function dispose() { if (disposed) return; disposed = true; if (active) await cancelTask(active.taskId) }
  return { executeTask, cancelTask, dispose }
}

function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new TypeError('model profile is required')
  for (const k of ['id', 'provider', 'model', 'protocol', 'apiKeyEnv']) if (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > 512) throw new TypeError(`model profile ${k} is required and must be at most 512 characters`)
  if (p.protocol !== 'openai-chat-completions') throw new TypeError(`unsupported model profile protocol: ${p.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv)) throw new TypeError('model profile apiKeyEnv must be a valid environment variable name')
  if (p.baseUrl !== undefined) { let u; try { u = new URL(p.baseUrl) } catch { throw new TypeError('model profile baseUrl must be a valid HTTP(S) URL') }; if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new TypeError('model profile baseUrl must be a credential-free HTTP(S) URL') }
  return { id: p.id, provider: p.provider, model: p.model, protocol: p.protocol, apiKeyEnv: p.apiKeyEnv, ...(p.baseUrl === undefined ? {} : { baseUrl: p.baseUrl }), ...(p.name === undefined ? {} : { name: p.name }) }
}
async function readMap(path) { try { const value = JSON.parse(await readFile(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Qwen session map must contain a JSON object'); return value } catch (e) { if (e.code === 'ENOENT') return {}; throw e } }
function redact(s, secrets) { let text = String(s); for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]'); return text }
function redactDeep(x, secrets) { if (typeof x === 'string') return redact(x, secrets); if (Array.isArray(x)) return x.map(v => redactDeep(v, secrets)); if (!x || typeof x !== 'object') return x; return Object.fromEntries(Object.entries(x).map(([k,v]) => [k, redactDeep(v, secrets)])) }
function kill(child, signal) { if (process.platform === 'win32' || !child.pid) child.kill(signal); else { try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') child.kill(signal) } } }
function eventQueue() { const items = []; let wake, done = false; return { push(x) { items.push(x); wake?.(); wake = null }, finish() { done = true; wake?.(); wake = null }, async next() { while (!items.length && !done) await new Promise(r => { wake = r }); return items.length ? { value: items.shift(), done: false } : { done: true } } } }
async function waitClose(p, ms) { let timer; return Promise.race([p.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), ms) })]).finally(() => clearTimeout(timer)) }
