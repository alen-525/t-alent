import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '2026.9.8'
export async function createAgentPackage(options) {
  const dir = resolve(dirname(fileURLToPath(import.meta.resolve('openclaw'))), '..')
  const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'))
  if (pkg.version !== VERSION) throw new Error(`OpenClaw ${VERSION} is required, found ${pkg.version}`)
  return createAgentPackageWithRuntime(options, { command: process.execPath, bin: resolve(dir, 'openclaw.mjs'), spawnProcess: spawn })
}

export async function createAgentPackageWithRuntime({ workspace, stateDir, env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  for (const key of Object.keys(config)) if (!['cancelGraceMs', 'timeoutSeconds'].includes(key)) throw new TypeError(`Unsupported OpenClaw behavior config: ${key}; model routing comes from the host`)
  const grace = config.cancelGraceMs ?? 3000, timeout = config.timeoutSeconds ?? 600
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60000) throw new TypeError('Invalid cancelGraceMs')
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) throw new TypeError('Invalid timeoutSeconds')
  const root = resolve(workspace), state = resolve(stateDir), environment = { ...process.env, ...env }
  await mkdir(state, { recursive: true, mode: 0o700 })
  let active, disposed = false
  function executeTask({ taskId, input, sessionId, model }, { signal } = {}) {
    if (disposed) throw new Error('OpenClaw package is disposed')
    if (active) throw new Error('OpenClaw package already has an active task')
    if (typeof taskId !== 'string' || !taskId || typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 4 * 1024 * 1024) throw new TypeError('taskId and input of at most 4 MiB are required')
    const profile = validateProfile(model), apiKey = environment[profile.apiKeyEnv]
    if (typeof apiKey !== 'string' || !apiKey) throw new TypeError(`Missing model API key environment variable ${profile.apiKeyEnv}`)
    const key = hash(JSON.stringify([root, sessionId || taskId, profile]))
    const nativeSession = `${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`
    const task = { taskId, key, nativeSession, profile, apiKey, signal, cancelling: !!signal?.aborted, queue: eventQueue(), child: null, closed: false,
      secrets: [...new Set([apiKey, ...Object.entries(environment).filter(([k,v]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)])] }
    active = task
    task.finished = Promise.resolve().then(() => run(task, input))
    task.abort = () => { void cancelTask(taskId) }
    signal?.addEventListener('abort', task.abort, { once: true })
    return { async *[Symbol.asyncIterator]() {
      try { for (;;) { const next = await task.queue.next(); if (next.done) return; yield next.value } }
      finally { if (active === task) await cancelTask(taskId) }
    } }
  }
  async function run(task, input) {
    const emit = event => task.queue.push(redact(event, task.secrets))
    let stdout = '', stderr = '', overflow, promptPath
    try {
      if (task.cancelling) return
      const home = resolve(state, 'conversations', task.key), nativeState = resolve(home, '.openclaw')
      await mkdir(nativeState, { recursive: true, mode: 0o700 })
      const configPath = resolve(nativeState, 'openclaw.json'), ref = `talent/${task.profile.model}`
      const api = { 'openai-chat-completions': 'openai-completions', 'openai-responses': 'openai-responses', anthropic: 'anthropic-messages' }[task.profile.protocol]
      const baseUrl = task.profile.baseUrl ?? (task.profile.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
      const settings = {
        agents: { defaults: { workspace: root, skipBootstrap: true, model: { primary: ref, fallbacks: [] }, modelPolicy: { allow: [ref] }, heartbeat: { every: '0m' }, timeoutSeconds: timeout } },
        memory: { search: { enabled: false } },
        models: { mode: 'replace', providers: { talent: { api, baseUrl, apiKey: { source: 'env', provider: 'default', id: 'TALENT_OPENCLAW_MODEL_KEY' }, agentRuntime: { id: 'openclaw' }, models: [{ id: task.profile.model, name: task.profile.model, api, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 }] } } },
        browser: { enabled: false }, tools: { profile: 'coding', deny: ['group:ui', 'group:messaging', 'gateway', 'cron'], fs: { workspaceOnly: true } },
        update: { checkOnStart: false, auto: { enabled: false } }, telemetry: { enabled: false }, env: { shellEnv: { enabled: false } },
      }
      await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 })
      promptPath = resolve(nativeState, `task-${hash(task.taskId).slice(0,16)}.txt`)
      await writeFile(promptPath, input, { mode: 0o600 })
      const childEnv = { ...environment }
      for (const k of Object.keys(childEnv)) if (/^(OPENCLAW_|ANTHROPIC_|OPENAI_|OTEL_|NODE_OPTIONS$|TALENT_OPENCLAW_)/.test(k)) delete childEnv[k]
      Object.assign(childEnv, { HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: nativeState, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_AUTO_UPDATE: '1', OPENCLAW_DISABLE_BONJOUR: '1', TALENT_OPENCLAW_MODEL_KEY: task.apiKey, BROWSER: '/usr/bin/true', NO_COLOR: '1' })
      const args = [runtime.bin, 'agent', '--local', '--agent', 'main', '--session-id', task.nativeSession, '--model', ref, '--json', '--thinking', 'off', '--timeout', String(timeout), '--message-file', promptPath]
      await runtime.beforeSpawn?.()
      if (task.cancelling) return
      const child = runtime.spawnProcess(runtime.command, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' })
      task.child = child
      task.close = new Promise(resolveClose => {
        let spawnError
        child.once('error', e => { spawnError = e })
        child.once('close', (code, signal) => { task.closed = true; resolveClose({ code, signal, spawnError }) })
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { overflow = new Error('OpenClaw output exceeded 8 MiB'); void cancelTask(task.taskId) } })
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
      const outcome = await task.close
      if (overflow) throw overflow
      if (task.cancelling) return
      if (outcome.spawnError) throw outcome.spawnError
      if (outcome.code !== 0) throw new Error(`OpenClaw exited ${outcome.code}: ${stderr}`)
      let result
      try { result = JSON.parse(stdout) } catch { throw new Error('OpenClaw exited without a valid native JSON result') }
      if (!result || !Array.isArray(result.payloads) || typeof result.meta?.agentMeta?.sessionId !== 'string') throw new Error('OpenClaw returned an incomplete native result')
      if (result.meta.error || result.meta.aborted || ['error','timeout','aborted','toolUse'].includes(result.meta.stopReason) || result.payloads.some(p => p.isError)) throw new Error(`OpenClaw failed: ${JSON.stringify(result.meta.error ?? result.meta.stopReason ?? result.payloads)}`)
      const text = result.payloads.map(p => p.text).filter(v => typeof v === 'string' && v.trim()).join('\n')
      if (!text) throw new Error('OpenClaw exited without an assistant response')
      emit({ type: 'session', sessionId: result.meta.agentMeta.sessionId })
      if (result.meta.toolSummary) emit({ type: 'harness-event', event: { type: 'native-tool-summary', summary: result.meta.toolSummary } })
      emit({ type: 'assistant-replace', text })
      emit({ type: 'assistant-complete' })
    } catch (e) {
      if (task.child && !task.closed) await stopChild(task, grace)
      if (!task.cancelling || overflow) emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (promptPath) await rm(promptPath, { force: true }).catch(() => {})
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
  for (const key of ['id','provider','model','protocol','apiKeyEnv']) if (typeof model[key] !== 'string' || !model[key].trim() || model[key] !== model[key].trim()) throw new TypeError(`Invalid model profile ${key}`)
  if (!['openai-chat-completions','openai-responses','anthropic'].includes(model.protocol)) throw new TypeError(`Unsupported model protocol ${model.protocol}`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv) || model.model.length > 200 || model.id.length > 200) throw new TypeError('Invalid model profile')
  if (model.baseUrl !== undefined) { const url = new URL(model.baseUrl); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid model baseUrl') }
  return Object.fromEntries(['id','provider','model','protocol','apiKeyEnv','baseUrl'].filter(k => model[k] !== undefined).map(k => [k, model[k]]))
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function redact(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((v,s) => v.replaceAll(s, '[redacted]'), value)
  if (Array.isArray(value)) return value.map(v => redact(v,secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,secrets)]))
  return value
}
function eventQueue() {
  const values = [], waiting = []; let done = false
  return { push(value) { if (!done) { if (waiting.length) waiting.shift()({value,done:false}); else values.push(value) } }, finish() { done = true; while(waiting.length) waiting.shift()({done:true}) }, next() { return values.length ? Promise.resolve({value:values.shift(),done:false}) : done ? Promise.resolve({done:true}) : new Promise(r => waiting.push(r)) } }
}
async function stopChild(task, grace) {
  const kill = signal => { try { if (process.platform !== 'win32' && task.child.pid) process.kill(-task.child.pid,signal); else task.child.kill(signal) } catch(e) { if(e.code !== 'ESRCH') throw e } }
  kill('SIGTERM'); let timer
  try { await Promise.race([task.close,new Promise(r => { timer = setTimeout(r,grace) })]) } finally { clearTimeout(timer) }
  if (!task.closed) kill('SIGKILL')
  await task.close
}
