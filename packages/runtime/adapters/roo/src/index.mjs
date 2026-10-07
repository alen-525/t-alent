import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.17'

export async function createAgentPackage({ workspace, stateDir, env, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  const probeHome = resolve(stateDir, 'version-probe')
  await mkdir(probeHome, { recursive: true, mode: 0o700 })
  const probeEnv = { ...process.env, ...(env ?? {}), HOME: probeHome, XDG_CONFIG_HOME: probeHome, XDG_DATA_HOME: probeHome, BROWSER: '/usr/bin/true' }
  for (const name of Object.keys(probeEnv)) if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name === 'NODE_OPTIONS') delete probeEnv[name]
  const program = config.program ?? env?.ROO_BIN ?? process.env.ROO_BIN ?? resolve(stateDir, 'roo-runtime', 'roo-cli-darwin-arm64', 'bin', 'roo')
  try {
    const { stdout } = await import('node:child_process').then(({ execFile }) => new Promise((ok, fail) => execFile(program, ['--version'], { timeout: 10000, env: probeEnv, cwd: probeHome }, (e, stdout) => e ? fail(e) : ok({ stdout }))))
    if (!new RegExp(`(?:^|\\s)${VERSION.replaceAll('.', '\\.')}(?:\\s|$)`).test(stdout.trim())) throw new Error(`expected exact ${VERSION}, got ${stdout.trim()}`)
  } catch (error) { throw new Error(`Pinned Roo CLI v${VERSION} is not installed or mismatched at ${program}. Run setup:runtime. ${error.message}`) }
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: program, spawnProcess: spawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env = {}, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  const unknownConfig = Object.keys(config).filter(key => !['program', 'cancelGraceMs'].includes(key))
  if (unknownConfig.length) throw new TypeError(`unsupported Roo adapter config: ${unknownConfig.join(', ')}`)
  if (config.cancelGraceMs !== undefined && (!Number.isSafeInteger(config.cancelGraceMs) || config.cancelGraceMs < 1 || config.cancelGraceMs > 60_000)) throw new TypeError('cancelGraceMs must be an integer from 1 to 60000')
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('Roo runtime command and spawnProcess are required')
  const root = resolve(workspace), state = resolve(stateDir)
  await mkdir(state, { recursive: true })
  const mapPath = join(state, 'roo-sessions.json')
  let sessions = {}; try { sessions = JSON.parse(await readFile(mapPath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions) || Object.entries(sessions).some(([key, id]) => !/^[a-f0-9]{64}$/.test(key) || typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new Error('Invalid Roo session store')
  let active, disposed = false
  const grace = config.cancelGraceMs ?? 3000
  async function persist() { const tmp = `${mapPath}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(sessions), { mode: 0o600 }); await rename(tmp, mapPath) }
  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Roo package is disposed')
    if (active) throw new Error(`Roo package already has active task ${active.id}`)
    if (!taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and non-empty input are required')
    const profile = validate(model), hostEnv = { ...process.env, ...env }
    const key = hostEnv[profile.apiKeyEnv]
    if (!key) throw new TypeError(`model profile API key environment variable ${profile.apiKeyEnv} is missing`)
    const conversation = createHash('sha256').update(JSON.stringify([root, String(sessionId || taskId), profile.fingerprint])).digest('hex')
    let nativeId = sessions[conversation]
    if (!nativeId) nativeId = uuidFromHash(conversation)
    const q = queue(), task = { id: taskId, q, child: null, server: null, settled: false, cancel: null, grace, signal, abort: null, secrets: [key] }
    active = task
    task.done = run(task, { input, profile, key, nativeId, isNew: !sessions[conversation], root, state, runtime, hostEnv }).then(async () => { if (task.completed && !task.cancelling && !signal?.aborted) { sessions[conversation] = nativeId; await persist(); q.push({ type: 'assistant-replace', text: task.answer || '' }); q.push({ type: 'assistant-complete' }) } }).catch(error => { if (!task.cancelling && !signal?.aborted) q.push({ type: 'error', message: redact(error.message, task.secrets) }) }).finally(() => { if ((task.cancelling || signal?.aborted) && !task.cancelEventSent) { task.cancelEventSent = true; q.push({ type: 'cancelled' }) }; task.settled = true; signal?.removeEventListener('abort', task.abort); if (active === task) active = null; q.end() })
    task.abort = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abort(); else signal?.addEventListener('abort', task.abort, { once: true })
    return { async *[Symbol.asyncIterator]() { try { for (;;) { const next = await q.next(); if (next.done) return; yield next.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }
  async function cancelTask(taskId) {
    const t = active; if (!t || t.id !== taskId || t.settled) return
    t.cancel ??= (async () => {
      t.cancelling = true
      signalTree(t.child, 'SIGINT')
      if (t.child && t.childClose) {
        let timer
        const timedOut = new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout('timeout'), grace) })
        if (await Promise.race([t.childClose.then(() => 'closed'), timedOut]) === 'timeout') {
          signalTree(t.child, 'SIGKILL')
          await t.childClose
        }
        clearTimeout(timer)
      }
      await t.done
    })()
    await t.cancel
  }
  async function dispose() { disposed = true; if (active) await cancelTask(active.id) }
  return { executeTask, cancelTask, dispose }
}

async function run(t, { input, profile, key, nativeId, root, state, runtime, hostEnv }) {
  const profileDir = join(state, 'profiles', profile.fingerprint)
  await mkdir(profileDir, { recursive: true })
  if (t.cancelling || t.signal?.aborted) return
  const relayToken = randomBytes(32).toString('base64url')
  const upstreamControllers = new Set()
  const relay = createServer(async (req, res) => {
    let size = 0
    const controller = new AbortController()
    upstreamControllers.add(controller)
    res.once('close', () => controller.abort())
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
      if (req.headers.authorization !== `Bearer ${relayToken}`) { res.writeHead(401).end(); return }
      const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) { req.destroy(); return } chunks.push(chunk) }
      const body = Buffer.concat(chunks)
      const parsed = JSON.parse(body.toString())
      if (parsed.model !== profile.model) { res.writeHead(400).end('Roo model mismatch'); return }
      const url = new URL('chat/completions', profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`)
      const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body, signal: controller.signal })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      if (upstream.body) {
        const decoder = new TextDecoder()
        const patterns = [...new Set([key, JSON.stringify(key).slice(1, -1)])]
        const keep = Math.max(...patterns.map(value => value.length)) - 1
        let buffered = ''
        for await (const chunk of upstream.body) {
          buffered = redact(buffered + decoder.decode(chunk, { stream: true }), patterns)
          const safeLength = Math.max(0, buffered.length - keep)
          if (!res.destroyed && safeLength) res.write(buffered.slice(0, safeLength))
          buffered = buffered.slice(safeLength)
        }
        if (!res.destroyed) res.write(redact(buffered + decoder.decode(), patterns))
      }
      if (!res.destroyed) res.end()
    } catch (e) { if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end(String(e.message).slice(0, 300)) } }
    finally { upstreamControllers.delete(controller) }
  })
  t.server = relay
  let child, result, stderr = '', stdout = ''
  try {
    await new Promise((resolveListen, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolveListen) })
    if (t.cancelling || t.signal?.aborted) return
    const relayUrl = `http://127.0.0.1:${relay.address().port}/v1`
    const runner = join(dir, '../scripts/roo-launcher.mjs')
    const args = ['--print', '--output-format', 'stream-json', '--stdin-prompt-stream', '--oneshot', '--exit-on-error', '--workspace', root, '--mode', 'code', '--api-key', relayToken, '--provider', 'openai-native', '--model', profile.model]
    t.q.push({ type: 'session', sessionId: nativeId })
    const childEnv = { ...hostEnv }
    for (const [name, value] of Object.entries(childEnv)) {
      if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI_|ANTHROPIC_)/i.test(name) || name === 'NODE_OPTIONS' || value === key) delete childEnv[name]
    }
    Object.assign(childEnv, { HOME: profileDir, XDG_CONFIG_HOME: join(profileDir, 'config'), XDG_DATA_HOME: join(profileDir, 'data'), XDG_CACHE_HOME: join(profileDir, 'cache'), TALENT_ROO_MODEL: profile.model, TALENT_ROO_BASE_URL: relayUrl, TALENT_ROO_RELAY_KEY: relayToken, BROWSER: '/usr/bin/true', ROO_DISABLE_TELEMETRY: '1' })
    child = runtime.spawnProcess(process.execPath, [runner, runtime.command, ...args], { cwd: root, detached: process.platform !== 'win32', shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
    t.child = child
    t.childClose = new Promise(resolveClose => { child.once('error', error => { t.spawnError = error }); child.once('close', (code, signal) => { t.childClosed = true; resolveClose({ code, signal }) }) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (t.error || t.cancelling) return
      let n
      while ((n = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, n); stdout = stdout.slice(n + 1)
        if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) t.error = 'Roo emitted an oversized JSON stream line'
        if (t.error || !accept(t, line)) { void stopChild(t); return }
      }
      if (Buffer.byteLength(stdout, 'utf8') > 4 * 1024 * 1024) { t.error = 'Roo emitted an oversized JSON stream line'; void stopChild(t) }
    })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { if (stderr.length < 12000) stderr += String(c).slice(0, 12000 - stderr.length) })
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ command: 'start', requestId: randomUUID(), taskId: nativeId, prompt: input }) + '\n')
    result = await t.childClose
    if (stdout.trim() && !accept(t, stdout)) t.error ||= 'Roo emitted an invalid final JSON stream event'
    if (!t.cancelling && !t.signal?.aborted && (t.spawnError || result.code !== 0 || !t.completed || t.error)) throw new Error(redact(t.error || stderr.trim() || t.spawnError?.message || `Roo exited ${result.signal || result.code} without completion`, t.secrets))

  } finally {
    for (const controller of upstreamControllers) controller.abort()
    relay.closeAllConnections()
    if (child && !t.childClosed) { signalTree(child, 'SIGKILL'); await t.childClose }
    if (relay.listening) await new Promise(resolveClose => relay.close(resolveClose))
    t.server = null
  }
}

function accept(t, line) {
  if (!line.trim() || t.cancelling) return true
  let e; try { e = JSON.parse(line) } catch { t.error = `Roo emitted invalid JSON: ${redact(line.slice(0,300), t.secrets)}`; return false }
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') { t.error = 'Roo emitted a malformed stream event'; return false }
  const type = e.type ?? e.event
  if (type === 'control') return true
  if (!['assistant', 'text', 'assistant-delta', 'message', 'thinking', 'tool_use', 'tool-call', 'tool', 'tool_result', 'tool-result', 'error', 'result', 'done', 'completion', 'user', 'system'].includes(type)) { t.error = `Roo emitted unsupported stream event: ${String(type)}`; return false }
  if (type === 'thinking') { const text=e.content ?? e.text; if(typeof text==='string') t.q.push({type:'reasoning',text:redact(text,t.secrets)}) }
  else if (type === 'assistant' || type === 'text' || type === 'assistant-delta' || type === 'message') {
    const text = e.text ?? e.content ?? e.message
    if (typeof text === 'string') { const clean = redact(text, t.secrets); t.answer = (t.answer || '') + clean; t.q.push({ type: 'assistant-delta', text: clean }) }
  } else if (type === 'tool_use' || type === 'tool-call' || type === 'tool') { const call=e.tool_use ?? e; t.q.push({ type: 'tool-call', name: call.name ?? e.name ?? 'roo-tool', input: sanitize(call.input ?? e.arguments, t.secrets), callId: e.id ?? randomUUID() }) }
  else if (type === 'tool_result' || type === 'tool-result') t.q.push({ type: 'tool-result', name: e.tool_result?.name ?? e.name ?? 'roo-tool', output: redact(typeof e.tool_result?.output === 'string' ? e.tool_result.output : typeof e.output === 'string' ? e.output : JSON.stringify(e.tool_result ?? e.output ?? ''), t.secrets), status: Number.isInteger(e.tool_result?.exitCode) ? (e.tool_result.exitCode === 0 ? 'success' : 'error') : 'unknown' })
  else if (type === 'error') t.error = redact(e.content ?? e.message ?? JSON.stringify(e), t.secrets)
  else if (type === 'result' || type === 'done' || type === 'completion') { if (typeof e.success !== 'boolean') { t.error = 'Roo completion event did not report success'; return false }; t.completed = e.success; const text=e.content ?? e.text; if (typeof text==='string' && !t.answer) { t.answer = redact(text,t.secrets); t.q.push({ type:'assistant-delta', text:t.answer }) } }
  return true
}
async function stopChild(task) {
  if (task.stopPromise) return task.stopPromise
  task.stopPromise = (async () => {
    signalTree(task.child, 'SIGTERM')
    if (!task.childClose) return
    let timer
    try {
      if (await Promise.race([task.childClose.then(() => true), new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), task.grace) })]) === false) { signalTree(task.child, 'SIGKILL'); await task.childClose }
    } finally { clearTimeout(timer) }
  })()
  return task.stopPromise
}

function validate(m) {
  if (!m || m.protocol !== 'openai-chat-completions') throw new TypeError('unsupported model profile protocol; expected openai-chat-completions')
  for (const k of ['id', 'provider', 'model', 'apiKeyEnv']) if (typeof m[k] !== 'string' || !m[k].trim()) throw new TypeError(`model profile ${k} is required`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.apiKeyEnv) || m.model.length > 200 || m.id.length > 200) throw new TypeError('model profile id/model or apiKeyEnv is invalid')
  const endpoint = new URL(m.baseUrl ?? 'https://api.openai.com/v1')
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError('invalid model profile baseUrl')
  const fingerprint = createHash('sha256').update(JSON.stringify([m.id, m.provider, m.model, m.protocol, m.apiKeyEnv, endpoint.href])).digest('hex')
  return { model:m.model, apiKeyEnv:m.apiKeyEnv, baseUrl:endpoint.href, fingerprint }
}
function uuidFromHash(s) { const h=createHash('sha256').update(s).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}` }
function redact(s, secrets) { let x=String(s); for (const secret of secrets) if(secret) x=x.split(secret).join('[redacted]'); return x }
function sanitize(x, secrets) { return redact(typeof x==='string'?x:JSON.stringify(x ?? null), secrets) }
function queue() { const values=[], waiters=[]; let ended=false; return { push(v){ if(waiters.length) waiters.shift()({value:v}); else values.push(v) }, end(){ended=true; while(waiters.length) waiters.shift()({done:true})}, next(){ if(values.length)return Promise.resolve({value:values.shift()}); if(ended)return Promise.resolve({done:true}); return new Promise(r=>waiters.push(r)) } } }
function signalTree(child, signal) { if (!child || child.exitCode !== null || child.signalCode !== null) return; try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
