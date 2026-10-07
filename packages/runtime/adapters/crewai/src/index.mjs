import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const VERSION = '1.15.23', MAX_LINE = 4 * 1024 * 1024
export async function createAgentPackage({ workspace, stateDir, env = {}, config = {} }) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  const runtimeRoot = resolve(stateDir, 'crewai-runtime')
  const python = config.python ?? env.TALENT_CREWAI_PYTHON ?? process.env.TALENT_CREWAI_PYTHON ?? env.TALENT_PYTHON ?? process.env.TALENT_PYTHON ?? resolve(runtimeRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const { execFile } = await import('node:child_process')
  const probeHome = resolve(runtimeRoot, 'probe-home')
  await mkdir(probeHome, { recursive: true, mode: 0o700 })
  const probeEnv = cleanEnv(process.env)
  Object.assign(probeEnv, { HOME: probeHome, XDG_CONFIG_HOME: join(probeHome, 'config'), XDG_CACHE_HOME: join(probeHome, 'cache'), XDG_DATA_HOME: join(probeHome, 'data'), PYTHONNOUSERSITE: '1', BROWSER: '/usr/bin/true' })
  const version = await new Promise((resolveVersion, reject) => execFile(python, ['-c', 'import importlib.metadata as m; from crewai import Agent, Crew, LLM, Task; from crewai_tools import FileReadTool, FileWriterTool; print(m.version(\"crewai\")); print(m.version(\"crewai-tools\"))'], { timeout: 10000, env: probeEnv, cwd: resolve(workspace) }, (e, stdout) => e ? reject(e) : resolveVersion(stdout.trim().split(/\s+/))))
  if (version[0] !== VERSION || version[1] !== VERSION) throw new Error(`CrewAI runtime must be exactly ${VERSION}/${VERSION}; run setup:runtime`)
  return createAgentPackageWithRuntime({ workspace, stateDir, env, config }, { command: python, argsPrefix: ['-u', join(packageDir, 'worker.py')], spawnProcess: spawn })
}
export async function createAgentPackageWithRuntime({ workspace, stateDir, env = {}, config = {} }, runtime) {
  if (!workspace || !stateDir) throw new TypeError('workspace and stateDir are required')
  if (Object.keys(config).some(k => !['python', 'cancelGraceMs'].includes(k))) throw new TypeError('unsupported CrewAI config key')
  if (!runtime || typeof runtime.command !== 'string' || typeof runtime.spawnProcess !== 'function') throw new TypeError('CrewAI worker runtime is required')
  const root=resolve(workspace), state=resolve(stateDir), grace=config.cancelGraceMs ?? 4000
  if (!Number.isSafeInteger(grace)||grace<1||grace>60000) throw new TypeError('cancelGraceMs must be 1..60000')
  await mkdir(state,{recursive:true,mode:0o700})
  let active=null, disposed=false
  function executeTask({taskId,input,sessionId,model},{signal}={}) {
    if(disposed) throw new Error('CrewAI package is disposed')
    if(active) throw new Error(`CrewAI package already has active task ${active.id}`)
    if(typeof taskId!=='string'||!taskId||typeof input!=='string'||!input.trim()) throw new TypeError('taskId and non-empty input are required')
    const p=profile(model), sourceEnv={...process.env,...env}, key=sourceEnv[p.apiKeyEnv]
    if(!key) throw new TypeError(`model profile API key environment variable ${p.apiKeyEnv} is missing`)
    const scope=hash(JSON.stringify([root,String(sessionId||taskId),p.id,p.provider,p.model,p.protocol,p.apiKeyEnv,p.baseUrl]))
    const taskDir=join(state,'profiles',scope), historyPath=join(taskDir,'history.json')
    const task={id:taskId,signal,queue:queue(),child:null,done:null,cancelled:false,settled:false,grace,env:childEnv(sourceEnv,key,taskDir),request:{taskId,input,workspace:root,historyPath,model:{id:p.id,provider:p.provider,model:p.model,protocol:p.protocol,baseUrl:p.baseUrl},apiKeyEnv:p.apiKeyEnv},buffer:'',stderr:'',terminal:null,failed:false,secret:key}
    active=task; task.done=run(task,runtime).finally(()=>{task.settled=true; if(task.cancelled) task.queue.push({type:'cancelled'});task.queue.end();signal?.removeEventListener('abort',task.abort);if(active===task)active=null})
    task.abort=()=>{void cancelTask(taskId)}; if(signal?.aborted)task.abort();else signal?.addEventListener('abort',task.abort,{once:true})
    return {async *[Symbol.asyncIterator](){try{for(;;){const n=await task.queue.next();if(n.done)return;yield n.value}}finally{if(!task.settled)await cancelTask(taskId)}}}
  }
  async function run(t,rt){
    try {
      await mkdir(dirname(t.request.historyPath),{recursive:true,mode:0o700})
      let prior=''; try {const h=JSON.parse(await readFile(t.request.historyPath,'utf8')); if(h.scope!==basename(dirname(t.request.historyPath))||typeof h.context!=='string')throw Error('invalid persisted context');prior=h.context}catch(e){if(e.code!=='ENOENT')throw e}
      if(t.cancelled||t.signal?.aborted)return
      t.request.priorContext=prior
      const child=rt.spawnProcess(rt.command,[...(rt.argsPrefix||[]),...(rt.args||[])],{cwd:t.request.workspace,env:t.env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});t.child=child
      t.close=new Promise(resolveClose=>{let done=false;const finish=x=>{if(!done){done=true;resolveClose(x)}};child.once('close',(code,signal)=>{t.childClosed=true;finish({code,signal})});child.once('error',e=>{t.error=e;finish({code:-1,error:e})})})
      child.stdout.setEncoding('utf8');child.stdout.on('data',c=>{if(t.cancelled||t.failed)return;t.buffer+=c;let n;while((n=t.buffer.indexOf('\n'))>=0){const line=t.buffer.slice(0,n);t.buffer=t.buffer.slice(n+1);if(Buffer.byteLength(line)>MAX_LINE){fail(t,'CrewAI worker NDJSON line too large');return}accept(t,line);if(t.failed)return}if(Buffer.byteLength(t.buffer)>MAX_LINE)fail(t,'CrewAI worker NDJSON line too large')})
      child.stderr.setEncoding('utf8');child.stderr.on('data',c=>{t.stderr=(t.stderr+c).slice(-20000)})
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(t.request)+'\n')
      const result=await t.close;if(t.buffer.trim()&&!t.failed)accept(t,t.buffer)
      if(t.cancelled||t.signal?.aborted)return
      if(t.failed)throw Error(t.failure)
      if(result.code!==0)throw Error(t.stderr.trim()||`CrewAI worker exited ${result.code}`)
      if(t.terminal!=='assistant-complete')throw Error('CrewAI worker exited without assistant-complete')
      t.queue.push({type:'assistant-complete'})
    }catch(e){if(!t.cancelled&&!t.signal?.aborted&&!t.errorSent){t.errorSent=true;t.queue.push({type:'error',message:redact(String(e.message||e),t.secret).slice(0,3000)})}}
  }
  function accept(t,line){if(!line.trim())return;if(t.terminal){fail(t,'CrewAI worker emitted events after terminal');return}let e;try{e=JSON.parse(line)}catch{fail(t,'CrewAI worker emitted malformed NDJSON');return}if(!e||typeof e!=='object'||Array.isArray(e)||typeof e.type!=='string'){fail(t,'CrewAI worker emitted malformed event');return}
    const schemas={'assistant-delta':['text'],'tool-call':['name','callId','input'],'tool-result':['name','callId','output'],'assistant-complete':[],'error':['message']}, required=schemas[e.type]
    if(!required||Object.keys(e).some(k=>!['type',...required].includes(k))||required.some(k=>typeof e[k]!=='string')){fail(t,`invalid CrewAI worker ${e.type} event`);return}
    const safe=redactDeep(e,t.secret)
    if(safe.type==='assistant-delta')t.queue.push(safe)
    else if(safe.type==='tool-call')t.queue.push(safe)
    else if(safe.type==='tool-result')t.queue.push(safe)
    else if(safe.type==='assistant-complete')t.terminal=safe.type
    else if(safe.type==='error'){t.terminal='error';t.errorSent=true;t.queue.push(safe)}
  }
  function fail(t,msg){if(t.failed)return;t.failed=true;t.failure=msg;if(!t.errorSent){t.errorSent=true;t.queue.push({type:'error',message:redact(msg,t.secret)})}if(t.child&&!t.childClosed)kill(t.child,'SIGTERM');if(t.close){const timer=setTimeout(()=>{if(!t.childClosed)kill(t.child,'SIGKILL')},grace);timer.unref?.()}}
  async function cancelTask(id){const t=active;if(!t||t.id!==id||t.settled)return;t.cancelPromise??=(async()=>{t.cancelled=true;if(t.child&&!t.childClosed){kill(t.child,'SIGTERM');if(!await wait(t.close,grace))kill(t.child,'SIGKILL')}await t.done})();await t.cancelPromise}
  async function dispose(){disposed=true;if(active)await cancelTask(active.id)}
  return {executeTask,cancelTask,dispose}
}
function profile(m){if(!m||typeof m!=='object'||Array.isArray(m))throw new TypeError('model profile is required');for(const k of ['id','provider','model','protocol','apiKeyEnv'])if(typeof m[k]!=='string'||!m[k].trim())throw new TypeError(`model profile ${k} required`);if(m.name!==undefined&&typeof m.name!=='string')throw new TypeError('model profile name must be a string');if(m.protocol!=='openai-chat-completions'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.apiKeyEnv))throw new TypeError('invalid CrewAI model profile');const u=new URL(m.baseUrl||'https://api.openai.com/v1');if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new TypeError('invalid model baseUrl');return{id:m.id,name:m.name,provider:m.provider,model:m.model,protocol:m.protocol,apiKeyEnv:m.apiKeyEnv,baseUrl:u.href}}
function redactDeep(value,secret){if(typeof value==='string')return redact(value,secret);if(Array.isArray(value))return value.map(item=>redactDeep(item,secret));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[redact(key,secret),redactDeep(item,secret)]));return value}
function redact(value,secret){return secret?String(value).split(secret).join('[redacted]'):String(value)}
function cleanEnv(source){const e={...source};for(const k of Object.keys(e))if(/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI_|ANTHROPIC_|NODE_OPTIONS/i.test(k))delete e[k];return e}
function hash(s){return createHash('sha256').update(s).digest('hex')}
function childEnv(source,key,taskDir){const e={...source};for(const k of Object.keys(e))if(e[k]===key||/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI_|ANTHROPIC_|LITELLM_|NODE_OPTIONS|PYTHONPATH|PYTHONHOME/i.test(k))delete e[k];Object.assign(e,{TALENT_CREWAI_API_KEY:key,HOME:join(taskDir,'home'),XDG_CONFIG_HOME:join(taskDir,'config'),XDG_CACHE_HOME:join(taskDir,'cache'),XDG_DATA_HOME:join(taskDir,'data'),BROWSER:'/usr/bin/true',PYTHONNOUSERSITE:'1',PYTHONUNBUFFERED:'1',NO_COLOR:'1'});return e}
function queue(){const a=[],w=[];let end=false;return{push(x){if(end)return;const f=w.shift();f?f({value:x}):a.push(x)},end(){end=true;while(w.length)w.shift()({done:true})},next(){if(a.length)return Promise.resolve({value:a.shift()});if(end)return Promise.resolve({done:true});return new Promise(r=>w.push(r))}}}
function wait(p,ms){return new Promise(resolveWait=>{let settled=false;const timer=setTimeout(()=>{settled=true;resolveWait(false)},ms);p.then(()=>{if(!settled){settled=true;clearTimeout(timer);resolveWait(true)}},()=>{if(!settled){settled=true;clearTimeout(timer);resolveWait(true)}})})}
function kill(c,s){try{if(process.platform!=='win32'&&c.pid)process.kill(-c.pid,s);else c.kill(s)}catch{try{c.kill(s)}catch{}}}
