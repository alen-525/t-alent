import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createAgentPackage(options) {
  return createAgentPackageWithRuntime(options, { command: process.execPath, bin: fileURLToPath(new URL('./worker.mjs', import.meta.url)), spawnProcess: spawn })
}

/** Only the subprocess boundary is substituted in contract tests. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (typeof workspace !== 'string' || !workspace || typeof stateDir !== 'string' || !stateDir) throw new TypeError('workspace and stateDir are required')
  for (const key of Object.keys(config)) if (!['instructions', 'maxIterations', 'cancelGraceMs'].includes(key)) throw new TypeError(`${key} is not supported; model routing comes from the external profile`)
  if (config.instructions !== undefined && typeof config.instructions !== 'string') throw new TypeError('instructions must be a string')
  if (config.maxIterations !== undefined && (!Number.isSafeInteger(config.maxIterations) || config.maxIterations < 1)) throw new TypeError('maxIterations must be positive')
  const grace = config.cancelGraceMs ?? 3000
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('Invalid cancelGraceMs')
  const root = resolve(workspace), state = resolve(stateDir)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const environment = { ...process.env, ...(env ?? {}) }
  let active, disposed = false

  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('Cline package is disposed')
    if (active) throw new Error('Cline package already has an active task')
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim()) throw new TypeError('taskId and input are required')
    const profile = validateProfile(model)
    const key = environment[profile.apiKeyEnv]
    if (typeof key !== 'string' || !key) throw new TypeError(`Missing model API key environment variable ${profile.apiKeyEnv}`)
    const route = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    const conversation = createHash('sha256').update(`${sessionId || taskId}\0${route}`).digest('hex')
    const task = { taskId, profile, key, conversation, signal, queue: eventQueue(), child: null, closed: false, cancelling: !!signal?.aborted,
      secrets: [...new Set([key, ...Object.entries(environment).filter(([k,v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)])] }
    active = task
    task.finished = Promise.resolve().then(() => run(task, input))
    task.abort = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abort, { once: true })
    return { async *[Symbol.asyncIterator]() {
      try { for (;;) { const n = await task.queue.next(); if (n.done) return; yield n.value } }
      finally { if (active === task) await cancelTask(taskId) }
    } }
  }

  async function run(task, input) {
    let buffer = '', stderr = '', terminal, parseError
    const emit = value => task.queue.push(redact(value, task.secrets))
    function accept(line) {
      if (!line.trim() || task.cancelling) return
      try {
        const event = JSON.parse(line)
        if (!event || typeof event.type !== 'string') throw new Error('Malformed Cline worker event')
        if (terminal) throw new Error('Cline worker emitted output after terminal event')
        if (event.type === 'assistant-complete' || event.type === 'error' || event.type === 'cancelled') terminal = event.type
        if (event.type !== 'assistant-complete') emit(event)
      } catch (e) { parseError ??= e }
    }
    try {
      if (task.cancelling) return
      const taskState = resolve(state, 'cline', task.conversation), home = resolve(taskState, 'home')
      await mkdir(home, { recursive: true, mode: 0o700 })
      const childEnv = { ...environment }
      for (const key of Object.keys(childEnv)) if (/^CLINE_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^NODE_OPTIONS$/i.test(key)) delete childEnv[key]
      delete childEnv[task.profile.apiKeyEnv]
      childEnv.HOME = home; childEnv.TALENT_CLINE_KEY = task.key; childEnv.NO_COLOR = '1'
      await runtime.beforeSpawn?.()
      if (task.cancelling) return
      const child = runtime.spawnProcess(runtime.command, [runtime.bin], { cwd: root, env: childEnv, stdio: ['pipe','pipe','pipe'], detached: process.platform !== 'win32', shell: false })
      task.child = child
      task.close = new Promise(resolveClose => {
        let error
        child.once('error', e => { error = e })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, error }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk; let newline
        while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1); accept(line) }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ input, workspace: root, stateDir: taskState, profile: task.profile, config }))
      const outcome = await task.close
      if (buffer.trim()) accept(buffer)
      if (task.cancelling) return
      if (outcome.error) throw outcome.error
      if (parseError) throw parseError
      if (terminal === 'error' || terminal === 'cancelled') return
      if (outcome.code !== 0 || terminal !== 'assistant-complete') throw new Error(`Cline worker exited ${outcome.code} without completed turn: ${stderr}`)
      emit({ type: 'assistant-complete' })
    } catch (e) {
      if (task.child && !task.closed) await stopChild(task, grace)
      if (!task.cancelling && terminal !== 'error') emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
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

function validateProfile(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('model profile is required')
  for (const key of ['id','provider','model','protocol','apiKeyEnv']) if (typeof p[key] !== 'string' || !p[key].trim() || p[key] !== p[key].trim()) throw new TypeError(`Invalid model profile ${key}`)
  if (p.protocol !== 'openai-chat-completions') throw new TypeError(`Unsupported model protocol: ${p.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv) || p.id.length > 200 || p.model.length > 200) throw new TypeError('Invalid model profile')
  if (p.baseUrl !== undefined) {
    const u = new URL(p.baseUrl)
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new TypeError('Invalid model baseUrl')
  }
  return Object.fromEntries(['id','provider','model','protocol','apiKeyEnv','baseUrl'].filter(k => p[k] !== undefined).map(k => [k,p[k]]))
}
function redact(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((v,s) => v.replaceAll(s,'[redacted]'),value)
  if (Array.isArray(value)) return value.map(v=>redact(v,secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,secrets)]))
  return value
}
function eventQueue() {
  const items=[], waiting=[]; let done=false
  return { push(value) { if (!done) { if(waiting.length) waiting.shift()({value,done:false}); else items.push(value) } },
    finish() { done=true; while(waiting.length) waiting.shift()({done:true}) },
    next() { return items.length ? Promise.resolve({value:items.shift(),done:false}) : done ? Promise.resolve({done:true}) : new Promise(r=>waiting.push(r)) } }
}
async function stopChild(task, grace) {
  const kill = signal => { try { if (process.platform !== 'win32' && task.child.pid) process.kill(-task.child.pid,signal); else task.child.kill(signal) } catch(e) { if(e.code!=='ESRCH') throw e } }
  kill('SIGTERM'); let timer
  try { await Promise.race([task.close,new Promise(r=>{timer=setTimeout(r,grace)})]) } finally { clearTimeout(timer) }
  kill('SIGKILL'); await task.close
}
