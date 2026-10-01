import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, realpath, writeFile, access, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const packageDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const codexPackageJson = require.resolve('@openai/codex/package.json')
const requireFromCodex = createRequire(codexPackageJson)
const mapName = 'codex-threads.json'

export async function createAgentPackage(options) {
  const bin = resolveNativeCodex()
  return createAgentPackageWithRuntime(options, { command: bin, bin: null, spawnProcess: spawn })
}

/** App Server process injection point for deterministic package tests. */
export async function createAgentPackageWithRuntime({ workspace, stateDir, env = process.env, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  const root = await realpath(workspace)
  const state = resolve(stateDir)
  const home = resolve(state, 'codex-home')
  await Promise.all([mkdir(state, { recursive: true }), mkdir(home, { recursive: true })])
  const homeConfig=resolve(home,'config.toml')
  try { await access(homeConfig) } catch { await writeFile(homeConfig,'cli_auth_credentials_store = \"ephemeral\"\n',{mode:0o600}) }
  const secrets = Object.entries({ ...process.env, ...(env ?? {}) }).filter(([k,v]) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) && typeof v === 'string' && v.length >= 4).map(([,v]) => v)
  const environment = { ...process.env, ...(env ?? {}), CODEX_HOME: home, CODEX_MANAGED_PACKAGE_ROOT: realpathSyncPackageRoot(), CODEX_MANAGED_BY_NPM: '1' }
  if (!environment.CODEX_API_KEY && environment.OPENAI_API_KEY) environment.CODEX_API_KEY = environment.OPENAI_API_KEY
  const apiKey = environment.CODEX_API_KEY
  const sessionsPath = resolve(state, mapName)
  const sessions = await readMap(sessionsPath)
  const grace = bounded(config.cancelGraceMs, 7000, 1000, 60000)
  let active = null, disposed = false

  async function persist() {
    const temp = `${sessionsPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(sessions), { mode: 0o600 })
    try { await rename(temp, sessionsPath) } finally { await rm(temp, { force: true }).catch(() => {}) }
  }
  async function transform(input, context) {
    if (!config.program) return input
    const path = resolve(root, config.program)
    const real = await realpath(path)
    if (relative(root, real).startsWith('..') || isAbsolute(relative(root, real))) throw new Error('Codex program must be inside the workspace')
    const module = await import(pathToFileURL(real).href)
    if (typeof module.transformInput !== 'function') return input
    const value = await module.transformInput(input, context)
    if (typeof value !== 'string' || !value.trim()) throw new Error('Codex program transformInput must return non-empty text')
    return value
  }
  function executeTask({ taskId, input, sessionId }, { signal } = {}) {
    if (disposed) throw new Error('Codex agent package is disposed')
    if (active) throw new Error(`Codex agent package already has active task ${active.taskId}`)
    if (!taskId || typeof taskId !== 'string') throw new TypeError('taskId is required')
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input is required')
    const task = makeTask({ taskId, sessionId: String(sessionId || taskId), input, signal, secrets })
    active = task
    task.finished = run(task)
    task.abort = () => { void cancelTask(taskId) }
    if (signal?.aborted) task.abort(); else signal?.addEventListener('abort', task.abort, { once: true })
    return { async *[Symbol.asyncIterator]() { try { while (true) { const n = await task.queue.next(); if (n.done) return; yield n.value } } finally { if (!task.settled) await cancelTask(taskId) } } }
  }
  async function cancelTask(taskId) {
    const task = active
    if (!task || task.taskId !== taskId || task.settled) return
    task.cancelPromise ??= (async () => {
      task.cancelling = true
      task.resolveCancel?.()
      await Promise.race([task.childReady, task.finished])
      if (task.child && !task.closed) {
        if (task.threadId && task.turnId) { void task.request('turn/interrupt',{threadId:task.threadId,turnId:task.turnId}).catch(()=>{}); await racePromise(task.turnDone,grace) }
        task.child.stdin?.end()
        if (!await raceClose(task.closePromise, Math.min(grace,1500))) { task.child.kill('SIGTERM'); if (!await raceClose(task.closePromise,1200)) { task.child.kill('SIGKILL'); await task.closePromise } }
      }
      await task.finished
    })()
    await task.cancelPromise
  }
  async function run(task) {
    let stderr = '', failure = null, final = null, completion = false
    try {
      if (!apiKey) throw new Error('Codex authentication is missing: set CODEX_API_KEY or OPENAI_API_KEY for the server process')
      const transformed = await cancellable(transform(task.input, { taskId: task.taskId, sessionId: task.sessionId, workspace: root }), task)
      if (transformed === CANCELLED) return
      if (runtime.beforeSpawn) { const allowed = await cancellable(runtime.beforeSpawn(), task); if (allowed === CANCELLED) return }
      const child = runtime.spawnProcess(runtime.command, runtime.bin ? [runtime.bin, 'app-server', '--listen', 'stdio://'] : ['app-server', '--listen', 'stdio://'], { cwd: root, env: environment, shell: false, stdio: ['pipe','pipe','pipe'] })
      task.child = child; task.signalReady()
      task.closePromise = new Promise(resolveClose => { child.once('error', e => { task.spawnError=e }); child.once('close',(code,sig)=>{task.closed=true;for(const [id,p] of task.pendingRequests??[]){clearTimeout(p.timer);p.reject(new Error('Codex App Server exited before responding'));task.pendingRequests.delete(id)}task.finishTurn?.();resolveClose({code,sig,error:task.spawnError})}) })
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        task.buffer += chunk
        let newline
        while ((newline = task.buffer.indexOf('\n')) >= 0) {
          const line = task.buffer.slice(0, newline)
          task.buffer = task.buffer.slice(newline + 1)
          try { receive(task, line) }
          catch (error) {
            task.failure = new Error(`Codex App Server protocol failure: ${safeMessage(error)}`)
            task.finishTurn?.()
          }
        }
      })
      child.stderr.on('data', chunk => { stderr=(stderr+chunk).slice(-8192) })
      child.stdin.on('error',()=>{})
      task.send = msg => { if (!task.closed && child.stdin.writable) child.stdin.write(JSON.stringify(msg)+'\n') }
      await task.request('initialize',{clientInfo:{name:'t-alent',version:'0.1.0'}})
      task.send({method:'initialized',params:{}})
      task.initialized = true
      await task.request('account/login/start',{type:'apiKey',apiKey})
      const previous = sessions[task.sessionId]
      let thread
      if (previous) thread = await task.request('thread/resume',resumeParams(previous,root,config))
      else thread = await task.request('thread/start',threadParams(root,config))
      task.threadId = thread.thread?.id ?? thread.threadId ?? thread.id
      if (typeof task.threadId !== 'string') throw new Error('Codex App Server thread response did not include a thread id')
      if (sessions[task.sessionId] !== task.threadId) { sessions[task.sessionId]=task.threadId; await persist() }
      task.queue.push({type:'session',sessionId:task.threadId})
      const turn = await task.request('turn/start',turnParams(task.threadId,transformed,config,root))
      task.turnId = turn.turn?.id ?? turn.turnId ?? turn.id
      if (task.pendingTurnId && task.pendingTurnId !== task.turnId) throw new Error('Codex App Server started an unexpected turn')
      if (turn.turn?.status === 'completed') completion = true
      if (!completion) await task.turnDone
      if (task.cancelling || task.signal?.aborted) return
      if (failure || task.failure) throw failure ?? task.failure
      if (!completion && task.completedTurn && task.turnStatus==='completed') completion=true
      if (task.completedTurn && task.turnStatus && task.turnStatus!=='completed' && !task.failure) throw new Error(`Codex turn ended with status ${task.turnStatus}`)
      if (!completion) throw new Error('Codex App Server closed before turn/completed')
      const text = final ?? task.messageText
      if (typeof text === 'string') task.queue.push({type:'assistant-replace',text})
      task.queue.push({type:'assistant-complete'})
      await closeChild(task, grace)
    } catch (error) {
      if (task.child && !task.closed) { task.child.stdin?.end(); if(!await raceClose(task.closePromise,Math.min(grace,1500))) { task.child.kill('SIGTERM'); if(!await raceClose(task.closePromise,1200)) task.child.kill('SIGKILL') }; await task.closePromise?.catch(()=>{}) }
      for(const p of task.pendingRequests?.values?.()??[]) {clearTimeout(p.timer);p.reject(new Error('Codex App Server closed before responding'))}
      task.finishTurn?.()
      if (!task.cancelling && !task.signal?.aborted) task.queue.push({type:'error',message:redact(`${safeMessage(error)}${stderr ? `: ${stderr}` : ''}`,task.secrets)})
    } finally {
      task.signalReady()
      if (task.abort) task.signal?.removeEventListener('abort',task.abort)
      task.settled=true
      if (task.cancelling && !task.cancelSent) { task.cancelSent=true; task.queue.push({type:'cancelled'}) }
      task.queue.finish(); if (active===task) active=null
    }
  }
  async function dispose() { if (disposed) return; disposed=true; if(active) await cancelTask(active.taskId) }
  return {executeTask,cancelTask,dispose}
}

function makeTask(base) {
  const output = queue(base.secrets)
  const requests = new Map()
  let nextRequestId = 0
  let resolveChildReady
  let resolveCancel
  let resolveTurn

  const childReady = new Promise(resolveReady => { resolveChildReady = resolveReady })
  const cancelRequested = new Promise(resolveCancelled => { resolveCancel = resolveCancelled })
  const turnDone = new Promise(resolveDone => { resolveTurn = resolveDone })

  const task = {
    ...base,
    queue: output,
    childReady,
    cancelRequested,
    resolveCancel,
    signalReady: resolveChildReady,
    buffer: '',
    threadId: null,
    turnId: null,
    messageText: '',
    errorSent: false,
    cancelSent: false,
    turnDone,
    finishTurn: resolveTurn,
    pendingRequests: requests,
    request(method, params) {
      const id = ++nextRequestId
      const promise = new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          requests.delete(id)
          rejectResult(new Error(`Codex App Server ${method} timed out`))
        }, 30_000)
        timer.unref?.()
        requests.set(id, { resolve: resolveResult, reject: rejectResult, method, timer })
      })
      task.send({ id, method, params })
      return promise
    },
    send() {},
    onResponse(message) {
      const pending = requests.get(message.id)
      if (!pending) return
      requests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result ?? {})
    },
    onNotification(message) {
      const params = message.params ?? {}
      if (!notificationBelongs(task, params, message.method)) return

      switch (message.method) {
        case 'turn/started': {
          const id = params.turn?.id ?? params.turnId
          if (typeof id === 'string') {
            task.pendingTurnId = id
            if (!task.turnId) task.turnId = id
          }
          output.push({ type: 'harness-event', event: message })
          break
        }
        case 'item/agentMessage/delta':
        case 'agentMessageDelta': {
          const delta = params.delta ?? params.textDelta
          if (typeof delta === 'string') {
            task.messageText += delta
            output.push({ type: 'assistant-delta', text: delta })
          }
          break
        }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          if (typeof params.delta === 'string') output.push({ type: 'reasoning', text: params.delta })
          break
        case 'item/started':
        case 'item/completed':
          itemEvent(task, message.method, params)
          break
        case 'turn/completed': {
          task.completedTurn = true
          task.turnStatus = params.turn?.status
          if (params.turn?.status === 'failed') {
            const turnError = params.turn.error
            const code = turnError?.codexErrorInfo
            const detail = typeof code === 'string' ? code : code ? JSON.stringify(code) : ''
            task.failure = new Error(turnError?.message ?? `Codex turn failed${detail ? `: ${detail}` : ''}`)
          }
          resolveTurn()
          break
        }
        case 'error':
          output.push({ type: 'harness-event', event: message })
          if (!params.willRetry) {
            task.errorSent = true
            task.failure = new Error(params.error?.message || params.message || 'Codex App Server error')
          }
          break
        case 'thread/started':
          if (params.thread?.id) task.threadId = params.thread.id
          output.push({ type: 'harness-event', event: message })
          break
        default:
          output.push({ type: 'harness-event', event: message })
      }
    },
    get failure() { return this._failure },
    set failure(value) { this._failure = value },
  }

  return task
}

function notificationBelongs(task,p,method){
 const threadId=p.threadId??p.thread?.id
 if(threadId&&task.threadId&&threadId!==task.threadId)return false
 const turnId=p.turnId??p.turn?.id
 if(method==='turn/started'&&typeof turnId==='string'){task.pendingTurnId=turnId;if(!task.turnId)task.turnId=turnId;return true}
 if(method==='turn/completed'&&typeof turnId==='string'&&task.turnId&&turnId!==task.turnId)return false
 if(turnId&&task.turnId&&turnId!==task.turnId)return false
 return true
}
function receive(task, line) {
  if (!line.trim()) return

  let message
  try {
    message = JSON.parse(line)
  } catch {
    task.failure = new Error(`Codex App Server emitted malformed JSON: ${line.slice(0, 300)}`)
    task.finishTurn?.()
    return
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    task.failure = new Error('Codex App Server emitted malformed JSON-RPC message')
    task.finishTurn?.()
    return
  }

  if (Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method')) {
    handleServerRequest(task, message)
    return
  }
  if (Object.hasOwn(message, 'id')) {
    task.onResponse(message)
    return
  }
  if (typeof message.method === 'string') {
    task.onNotification(message)
    return
  }

  task.failure = new Error('Codex App Server sent an unrecognized JSON-RPC message')
  task.finishTurn?.()
}

function handleServerRequest(task, message) {
  const { id, method } = message
  if (typeof method !== 'string') {
    task.failure = new Error('Codex App Server sent a malformed request method')
    task.finishTurn?.()
    return
  }
  if (method === 'account/login/completed') return
  if (method === 'account/login/request') {
    respondError(task, id, -32000, 'Interactive login is disabled; configure CODEX_API_KEY')
    return
  }
  if (method === 'item/permissions/requestApproval') {
    task.send({ id, result: { permissions: {}, scope: 'turn' } })
    return
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    task.send({ id, result: { decision: 'decline' } })
    return
  }
  if (method === 'item/tool/requestUserInput' || method.startsWith('mcp/')) {
    respondError(task, id, -32000, 'Server initiated requests are disabled by this adapter')
    task.failure = new Error(`Unsupported server request: ${method}`)
    task.finishTurn?.()
    return
  }

  respondError(task, id, -32601, `Unsupported server request: ${method}`)
  task.failure = new Error(`Unsupported server request: ${method}`)
  task.finishTurn?.()
}

function respondError(task, id, code, message) {
  task.send({ id, error: { code, message } })
}

function itemEvent(task, method, params) {
  const item = params.item ?? params
  if (!item || typeof item !== 'object') return

  const id = item.id ?? item.callId
  const toolTypes = new Set(['commandExecution', 'toolCall', 'mcpToolCall', 'dynamicToolCall', 'fileChange'])
  if (!['agentMessage', 'assistantMessage'].includes(item.type)) {
    task.queue.push({ type: 'harness-event', event: { method, params } })
  }
  if (toolTypes.has(item.type)) {
    if (method === 'item/started') {
      task.queue.push({
        type: 'tool-call',
        callId: String(id ?? randomUUID()),
        name: item.toolName ?? item.name ?? item.command ?? item.title ?? 'tool',
        input: item.arguments ?? item.input ?? {},
      })
    } else {
      task.queue.push({
        type: 'tool-result',
        callId: String(id ?? ''),
        output: item.result ?? item.output ?? item.aggregatedOutput ?? item.content ?? item.status ?? '',
      })
    }
  }
  if ((item.type === 'agentMessage' || item.type === 'assistantMessage') && typeof item.text === 'string') {
    task.messageText = item.text
  }
}

function sandboxPolicy(cwd){return {type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}}
function threadParams(cwd,config){return {cwd,approvalPolicy:'never',sandbox:'workspace-write',...(config.model?{model:config.model}:{}),...(config.instructions?{developerInstructions:config.instructions}:{}),...(config.codexConfig&&typeof config.codexConfig==='object'?{config:config.codexConfig}:{})}}
function resumeParams(threadId,cwd,config){return {threadId,cwd,approvalPolicy:'never',sandbox:'workspace-write',...(config.model?{model:config.model}:{}),...(config.instructions?{developerInstructions:config.instructions}:{}),...(config.codexConfig&&typeof config.codexConfig==='object'?{config:config.codexConfig}:{})}}
function turnParams(threadId,input,config,cwd){return {threadId,input:[{type:'text',text:input}],approvalPolicy:'never',sandboxPolicy:sandboxPolicy(cwd),...(config.model?{model:config.model}:{}),...(config.reasoningEffort?{effort:config.reasoningEffort}:{}),}}
async function readMap(path){let data;try{data=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code==='ENOENT')return Object.create(null);throw new Error(`Codex thread map is unreadable: ${e.message}`)}if(!data||typeof data!=='object'||Array.isArray(data)||Object.values(data).some(v=>typeof v!=='string'||!v))throw new Error('Codex thread map is malformed');return Object.assign(Object.create(null),data)}
function queue(secrets=[]){
 const values=[],waiters=[];let ended=false
 return {
  push(value){if(ended)return;const clean=redactDeep(value,secrets);const waiter=waiters.shift();waiter?waiter({value:clean,done:false}):values.push(clean)},
  finish(){ended=true;for(const waiter of waiters.splice(0))waiter({done:true})},
  next(){if(values.length)return Promise.resolve({value:values.shift(),done:false});if(ended)return Promise.resolve({done:true});return new Promise(resolveNext=>waiters.push(resolveNext))},
 }
}
function redactDeep(value,secrets){
 if(typeof value==='string')return redact(value,secrets)
 if(Array.isArray(value))return value.map(item=>redactDeep(item,secrets))
 if(value&&typeof value==='object'){const copy={};for(const [key,item] of Object.entries(value))Object.defineProperty(copy,key,{value:redactDeep(item,secrets),enumerable:true,configurable:true,writable:true});return copy}
 return value
}
function resolveNativeCodex(){
 if(!['x64','arm64'].includes(process.arch)) throw new Error(`Unsupported Codex architecture: ${process.arch}`)
 const target = process.platform==='darwin' ? (process.arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin') : process.platform==='win32' ? (process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc') : process.platform==='linux' ? (process.arch==='arm64'?'aarch64-unknown-linux-musl':'x86_64-unknown-linux-musl') : null
 if(!target) throw new Error(`Unsupported Codex platform: ${process.platform}/${process.arch}`)
 const names={'aarch64-apple-darwin':'@openai/codex-darwin-arm64','x86_64-apple-darwin':'@openai/codex-darwin-x64','aarch64-pc-windows-msvc':'@openai/codex-win32-arm64','x86_64-pc-windows-msvc':'@openai/codex-win32-x64','aarch64-unknown-linux-musl':'@openai/codex-linux-arm64','x86_64-unknown-linux-musl':'@openai/codex-linux-x64'}
 let root; try { root=dirname(requireFromCodex.resolve(`${names[target]}/package.json`)) } catch { root=dirname(codexPackageJson)}
 const bin=resolve(root,'vendor',target,'bin',process.platform==='win32'?'codex.exe':'codex')
 if(!existsSync(bin)) throw new Error(`Codex native executable is missing for ${target}; reinstall @openai/codex@0.159.3`)
 return bin
}
function realpathSyncPackageRoot(){try{return dirname(require.resolve('@openai/codex/package.json'))}catch{return packageDir}}
function bounded(v,d,min,max){return Number.isInteger(v)&&v>=min?Math.min(v,max):d}
function safeMessage(error){const value=error instanceof Error?error.message:error;try{return typeof value==='string'?value:String(value)}catch{return 'Unknown error'}}
function redact(text,secrets){for(const s of secrets)text=text.replaceAll(s,'[redacted]');return text}
const CANCELLED=Symbol('cancelled')
function cancellable(p,task){return Promise.race([Promise.resolve(p),task.cancelRequested.then(()=>CANCELLED)])}
function timed(p,ms){return new Promise(resolveResult=>{const timer=setTimeout(()=>resolveResult(false),ms);timer.unref?.();Promise.resolve(p).then(()=>{clearTimeout(timer);resolveResult(true)},()=>{clearTimeout(timer);resolveResult(true)})})}
function racePromise(p,ms){return timed(p,ms)}
async function closeChild(task,ms){if(!task.child||task.closed)return;task.child.stdin?.end();if(!await raceClose(task.closePromise,Math.min(ms,1500))){task.child.kill('SIGTERM');if(!await raceClose(task.closePromise,1200)){task.child.kill('SIGKILL');await task.closePromise}}}
function raceClose(p,ms){return timed(p,ms)}
