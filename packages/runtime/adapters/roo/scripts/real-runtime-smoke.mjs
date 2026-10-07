import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-roo-smoke-'))
const program = process.env.ROO_BIN ?? fileURLToPath(new URL('../../../../../.talent/roo/roo-runtime/roo-cli-darwin-arm64/bin/roo', import.meta.url))
const workspace = join(temp,'workspace'), stateDir=join(temp,'state')
await mkdir(workspace); await writeFile(join(workspace,'probe.txt'),'ROO_NATIVE_TOOL_PROOF_412')
let mode='tool', requests=[], pending
const server=createServer(async(req,res)=>{
  if(process.env.ROO_SMOKE_DEBUG) console.error('mock request',req.method,req.url)
  let raw=''; for await(const c of req) raw+=c
  const body=JSON.parse(raw); requests.push({ model:body.model, authorization:req.headers.authorization, body })
  assert.equal(req.headers.authorization,'Bearer local-smoke-secret')
  assert(['arbitrary-host-model-id','isolated-profile-model'].includes(body.model))
  const nativeNames=(body.tools??[]).map(t=>t.function?.name??t.name??'')
  assert(!nativeNames.some(name=>/browser_action|browser/i.test(name)),'browser tool must be disabled in Roo host settings')
  assert(!nativeNames.some(name=>/mcp/i.test(name)),'MCP tools must remain disabled in Roo host settings')
  if(mode==='error'){res.writeHead(401,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'SMOKE_AUTH_REJECTED'}}))}
  if(mode==='stall'){pending=res;return}
  res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive'})
  const send=x=>res.write(`data: ${JSON.stringify(x)}\n\n`)
  const prev=body.messages?.some(m=>m.role==='tool')
  if(mode==='tool'&&!prev){
    const tool=body.tools?.find(x=>x.function?.name==='execute_command'); assert(tool,'Roo original execute_command tool missing')
    send({id:'roo-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'roo-call-1',type:'function',function:{name:'execute_command',arguments:JSON.stringify({command:'cat probe.txt'})}}]},finish_reason:null}]})
    send({id:'roo-smoke',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})
  } else if(mode==='tool'||mode==='success') {
    const complete=body.tools?.find(x=>x.function?.name==='attempt_completion');assert(complete,'Roo native attempt_completion tool missing')
    send({id:'roo-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'roo-call-complete',type:'function',function:{name:'attempt_completion',arguments:JSON.stringify({result:'Roo completed the local smoke task.'})}}]},finish_reason:null}]})
    send({id:'roo-smoke',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})
  } else {
    send({id:'roo-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'Roo completed the local smoke task.'},finish_reason:null}]})
    send({id:'roo-smoke',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})
  }
  res.end('data: [DONE]\n\n')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
let agent
try {
 const profile={id:'smoke',name:'Local Roo smoke',provider:'mock',model:'arbitrary-host-model-id',protocol:'openai-chat-completions',apiKeyEnv:'ROO_SMOKE_KEY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}
 const opts={workspace,stateDir,env:{ROO_SMOKE_KEY:'local-smoke-secret'},config:{program,cancelGraceMs:300}}
 agent=await createAgentPackage(opts)
 const run=async(id,session='normal',model=profile,input='Use your native command tool to read probe.txt, then report its contents.')=>{const events=[],controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);try{for await(const e of agent.executeTask({taskId:id,input,sessionId:session,model},{signal:controller.signal})){events.push(e);if(process.env.ROO_SMOKE_DEBUG)console.error('event',e)}}finally{clearTimeout(timeout)}return events}
 const first=await run('first')
 assert(first.some(e=>e.type==='tool-call'&&e.name==='execute_command'),JSON.stringify(first))
 assert(first.some(e=>e.type==='tool-result'&&e.output.includes('ROO_NATIVE_TOOL_PROOF_412')),JSON.stringify(first))
 assert.equal(first.at(-1)?.type,'assistant-complete')
 assert(requests.some(r=>JSON.stringify(r.body.messages).includes('ROO_NATIVE_TOOL_PROOF_412')))
 await agent.dispose(); agent=null
 agent=await createAgentPackage(opts)
 const resumed=await run('resumed','normal',profile,'Continue the existing task and summarize what you read.')
 assert.equal(resumed.at(-1)?.type,'assistant-complete')
 assert(requests.some(r=>r.body.messages.filter(m=>m.role==='tool').some(m=>JSON.stringify(m).includes('ROO_NATIVE_TOOL_PROOF_412'))),'native Roo history should resume across adapter instances')
 const isolatedProfile={...profile,id:'isolated-profile',model:'isolated-profile-model'}
 const isolatedRequestIndex=requests.length
 const isolated=await run('isolated','normal',isolatedProfile,'Continue from this isolated model profile.')
 assert.equal(isolated.at(-1)?.type,'assistant-complete')
 const isolatedRequest=requests.slice(isolatedRequestIndex).find(r=>r.model==='isolated-profile-model')
 assert(!JSON.stringify(isolatedRequest.body.messages).includes('ROO_NATIVE_TOOL_PROOF_412'),'model profiles must have independent Roo native histories')
 mode='error';const failed=await run('error-task','error-session');assert(failed.some(e=>e.type==='error'),JSON.stringify(failed))
 mode='stall';const controller=new AbortController();const cancelEvents=[]
 const stream=agent.executeTask({taskId:'cancel-task',input:'wait for the mock server',sessionId:'cancel-session',model:profile},{signal:controller.signal})
 const iter=stream[Symbol.asyncIterator]();await new Promise(r=>setTimeout(r,800));controller.abort()
 for await(const e of {[Symbol.asyncIterator]:()=>iter})cancelEvents.push(e)
 assert(cancelEvents.some(e=>e.type==='cancelled'),JSON.stringify(cancelEvents))
 mode='success';const recovered=await run('recovered','recover-session');assert.equal(recovered.at(-1)?.type,'assistant-complete')
 assert.deepEqual([...new Set(requests.map(r=>r.model))].sort(),['arbitrary-host-model-id','isolated-profile-model'])
 await agent.dispose();agent=null
 const persisted=await readFile(join(stateDir,'roo-sessions.json'),'utf8');assert(!persisted.includes('local-smoke-secret'))
 const scan=async d=>{for(const ent of await readdir(d,{withFileTypes:true})){const p=join(d,ent.name);if(ent.isDirectory())await scan(p);else {const b=await readFile(p);assert(!b.includes('local-smoke-secret'),`host key persisted in ${p}`)}}}
 await scan(stateDir)
 console.log('Roo CLI smoke passed: native tool loop, exact model route, history, error, cancellation/recovery, and no persisted host key.')
} finally { if(agent)await agent.dispose();server.close();await rm(temp,{recursive:true,force:true}) }
