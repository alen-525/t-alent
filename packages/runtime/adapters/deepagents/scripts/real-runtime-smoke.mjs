import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(os.tmpdir(), 'talent-deepagents-smoke-'))
const workspace = join(temp, 'repo')
const stateDir = join(temp, 'state')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'sample.txt'), 'alpha\n')
const python = process.env.DEEPAGENTS_PYTHON ?? fileURLToPath(new URL('../../../../../.talent/deepagents/deepagents-runtime/venv/bin/python', import.meta.url))
const key = 'deepagents-smoke-secret-41'
let mode = 'edit'
let calls = 0
const requests = []
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  let raw=''
  for await(const chunk of req) raw += chunk
  const body=JSON.parse(raw)
  requests.push({ body, authorization:req.headers.authorization })
  calls += 1
  if(mode==='hang') return
  if(mode==='fail') { res.writeHead(401,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'mock unauthorized'}})); return }
  const tools=body.tools ?? []
  const toolName=tool=>tool.function?.name ?? tool.name
  const readTool=tools.find(tool=>toolName(tool)==='read_file')
  const writeTool=tools.find(tool=>toolName(tool)==='write_file')
  const taskTool=tools.find(tool=>toolName(tool)==='task')
  assert(readTool && writeTool, `Deep Agents SDK should register native read/write tools; got ${tools.map(toolName).join(', ')}`)
  const msgs=body.messages ?? []
  const lastUserIndex=msgs.reduce((found,message,index)=>message.role==='user'?index:found,-1)
  const turnMessages=msgs.slice(lastUserIndex+1)
  const hasReadResult=turnMessages.some(m=>m.role==='tool' && String(m.content).includes('alpha'))
  const hasWriteCall=turnMessages.some(m=>m.role==='assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(call=>call.function?.name==='write_file'))
  let message
  let finishReason
  if(!hasReadResult) {
    message={role:'assistant',content:null,tool_calls:[{id:`call-read-${calls}`,type:'function',function:{name:'read_file',arguments:JSON.stringify(fileArgs(readTool,'sample.txt'))}}]}
    finishReason='tool_calls'
  } else if(!hasWriteCall) {
    const task=JSON.stringify(msgs.slice(lastUserIndex)).includes('append second proof')?'alpha\nfirst proof\nsecond proof\n':'alpha\nfirst proof\n'
    message={role:'assistant',content:null,tool_calls:[{id:`call-write-${calls}`,type:'function',function:{name:'write_file',arguments:JSON.stringify(writeArgs(writeTool,'sample.txt',task))}}]}
    finishReason='tool_calls'
  } else {
    message={role:'assistant',content:'I read sample.txt and updated it with the requested proof line.',tool_calls:[]}
    finishReason='stop'
  }
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({id:`chatcmpl-${calls}`,object:'chat.completion',created:0,model:body.model,choices:[{index:0,message,finish_reason:finishReason}]}))
})

let agent
try {
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)})
  const port=server.address().port
  agent=await createAgentPackage({workspace,stateDir,env:{DEEP_SMOKE_KEY:key},config:{python,cancelGraceMs:500}})
  const profile={id:'deep-smoke',provider:'mock-compatible',model:'mock-deepagents',protocol:'openai-chat-completions',apiKeyEnv:'DEEP_SMOKE_KEY',baseUrl:`http://127.0.0.1:${port}/v1`}
  let events=await collect(agent,'first','resume-session',profile,'Read sample.txt and append first proof on its own line.')
  assert.equal(await readFile(join(workspace,'sample.txt'),'utf8'),'alpha\nfirst proof\n',`SDK read_file/write_file loop must modify the real workspace; events=${JSON.stringify(events)} requests=${JSON.stringify(requests.map(r=>({model:r.body.model,tools:(r.body.tools??[]).map(t=>t.function?.name),messages:r.body.messages}))).slice(0,5000)}`)
  assert(events.some(e=>e.type==='tool-call'&&e.name==='read_file'))
  assert(events.some(e=>e.type==='tool-result'&&e.name==='read_file'&&String(e.output).includes('alpha')))
  assert(events.some(e=>e.type==='tool-call'&&e.name==='write_file'))
  assert(events.some(e=>e.type==='assistant-complete'),`first turn should complete successfully: ${JSON.stringify(events)}`)
  assert(requests.every(r=>r.authorization===`Bearer ${key}`&&r.body.model==='mock-deepagents'))
  assert(requests.some(r=>(r.body.tools??[]).some(tool=>(tool.function?.name??tool.name)==='task')),'native default subagent tool should be available')
  const initialCalls=calls
  await agent.dispose()
  agent=await createAgentPackage({workspace,stateDir,env:{DEEP_SMOKE_KEY:key},config:{python,cancelGraceMs:500}})
  events=await collect(agent,'second','resume-session',profile,'Using our conversation, append second proof on its own line.')
  assert.equal(await readFile(join(workspace,'sample.txt'),'utf8'),'alpha\nfirst proof\nsecond proof\n','SDK checkpoint must restore state and continue a later turn')
  assert(events.some(e=>e.type==='assistant-complete'))
  assert(calls>initialCalls)

  mode='hang'
  const beforeCancel=calls
  const controller=new AbortController()
  const iterator=agent.executeTask({taskId:'cancel',sessionId:'cancel-session',model:profile,input:'Wait for the model.'},{signal:controller.signal})[Symbol.asyncIterator]()
  const deadline=Date.now()+15_000
  while(Date.now()<deadline&&calls===beforeCancel) await new Promise(r=>setTimeout(r,30))
  assert(calls>beforeCancel,'SDK should start a new API request before cancellation')
  controller.abort()
  const cancelled=[]
  for await(const e of {[Symbol.asyncIterator]:()=>iterator})cancelled.push(e)
  assert(cancelled.some(e=>e.type==='cancelled'))

  mode='edit'
  events=await collect(agent,'recovered','cancel-session',profile,'Read sample.txt and report completion.')
  assert(events.some(e=>e.type==='assistant-complete'),'original SDK recovers after active-request cancellation')
  const isolated={...profile,model:'other-deepagents-model'}
  events=await collect(agent,'isolated','resume-session',isolated,'Read sample.txt in a new model route.')
  assert(events.some(e=>e.type==='assistant-complete'))
  assert.equal(requests.at(-1).body.model,isolated.model)
  assert(!requests.at(-1).body.messages.some(m=>m.role==='user' && String(m.content).includes('append second proof')),'different routes have independent checkpoints')

  mode='fail'
  events=await collect(agent,'failure','failure-session',profile,'Trigger an API failure.')
  assert(events.some(e=>e.type==='error'),`HTTP 401 should become an error event: ${JSON.stringify(events)}`)
  assert.equal(events.some(e=>e.type==='assistant-complete'),false)
  assert.equal(JSON.stringify(events).includes(key),false)
  await scan(stateDir)
  console.log(`Deep Agents v0.7.21 SDK smoke passed: ${calls} mock calls; native read/write, subagent availability, cross-instance checkpoint resume, route isolation, active cancellation/recovery, HTTP 401 and credential storage verified.`)
} finally {
  await agent?.dispose()
  server.closeAllConnections()
  await new Promise(resolveClose=>server.close(()=>resolveClose()))
  await rm(temp,{recursive:true,force:true})
}

function fileArgs(tool,path) { const props=tool.function?.parameters?.properties??{}; const key=Object.keys(props).find(k=>/path|file/i.test(k))??'file_path'; return {[key]:path} }
function writeArgs(tool,path,content) { const args=fileArgs(tool,path); const props=tool.function?.parameters?.properties??{}; const contentKey=Object.keys(props).find(k=>/content|text/i.test(k))??'content'; args[contentKey]=content; return args }
async function collect(instance,taskId,sessionId,model,input){const events=[];for await(const e of instance.executeTask({taskId,sessionId,model,input}))events.push(e);return events}
async function scan(dir) { for(const e of await readdir(dir,{withFileTypes:true})) {const file=join(dir,e.name);if(e.isDirectory())await scan(file);else if(e.isFile())assert(!(await readFile(file)).includes(Buffer.from(key)),`credential not persisted in ${file}`)} }
