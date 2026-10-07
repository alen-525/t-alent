import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const directory = await mkdtemp(resolve(tmpdir(), 'talent-cline-smoke-'))
await writeFile(resolve(directory,'fixture.txt'),'CLINE_TOOL_PROOF_436')
const requests=[]; let mode='tool', toolSent=false, pending
const server=createServer(async(req,res)=>{
  let raw=''; for await(const c of req) raw+=c
  const body=JSON.parse(raw); requests.push({url:req.url,headers:req.headers,body})
  assert.equal(req.url,'/v1/chat/completions'); assert.equal(req.headers.authorization,'Bearer cline-mock-secret')
  if(mode==='stall') { pending=res; return }
  if(mode==='error') { res.writeHead(401,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'mock rejected cline-mock-secret'}})); return }
  let delta,finish
  if(mode==='tool'&&!toolSent) {
    toolSent=true
    const read=body.tools?.find(t=>/read.*file/i.test(t.function?.name??''))
    assert(read,`No native read tool: ${JSON.stringify(body.tools)}`)
    const schema=read.function.parameters
    const properties=schema.properties??{}
    let args
    if(properties.paths) args={paths:[resolve(directory,'fixture.txt')]}
    else if(properties.files) args={files:[resolve(directory,'fixture.txt')]}
    else if(properties.path) args={path:resolve(directory,'fixture.txt')}
    else throw new Error(`Unexpected native read schema: ${JSON.stringify(schema)}`)
    delta={role:'assistant',tool_calls:[{index:0,id:'cline-read-call',type:'function',function:{name:read.function.name,arguments:JSON.stringify(args)}}]};finish='tool_calls'
  } else { delta={role:'assistant',content:mode==='follow'?'CLINE_FOLLOW_OK':'CLINE_TOOL_OK'};finish='stop' }
  res.writeHead(200,{'content-type':'text/event-stream'})
  const chunk={id:'cline-mock',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]}
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:finish}]})}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)})
const model={id:'cline-mock',provider:'company',model:'cline-smoke-model',protocol:'openai-chat-completions',apiKeyEnv:'MODEL_CREDENTIAL',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}
const options={workspace:directory,stateDir:resolve(directory,'state'),env:{MODEL_CREDENTIAL:'cline-mock-secret'},config:{maxIterations:8,cancelGraceMs:500}}
let agent
const collect=async(input,id='task',sessionId='conversation',profile=model)=>{const events=[];for await(const e of agent.executeTask({taskId:id,input,sessionId,model:profile})) events.push(e);return events}
const timeout=setTimeout(()=>{console.error('Cline smoke timed out');void agent?.dispose();pending?.destroy()},60000)
try {
  agent=await createAgentPackage(options)
  let events=await collect('Read fixture.txt with the native file tool then answer.')
  assert.equal(events.at(-1)?.type,'assistant-complete',JSON.stringify(events))
  assert(events.some(e=>e.type==='tool-call')); assert(events.some(e=>e.type==='tool-result'))
  assert(requests.some(r=>JSON.stringify(r.body.messages).includes('CLINE_TOOL_PROOF_436')),'Native tool result must return to the model')
  await agent.dispose();agent=await createAgentPackage(options);mode='follow'
  const before=requests.length
  events=await collect('Continue the previous conversation.','follow')
  assert.equal(events.at(-1)?.type,'assistant-complete',JSON.stringify(events))
  assert(requests.slice(before).some(r=>JSON.stringify(r.body.messages).includes('CLINE_TOOL_OK')),'Canonical messages must restore across instances')
  const beforeIsolated=requests.length
  await collect('Fresh route.','isolated','conversation',{...model,model:'different-model'})
  assert(!requests.slice(beforeIsolated).some(r=>JSON.stringify(r.body.messages).includes('CLINE_TOOL_OK')))
  mode='stall'
  const running=collect('Wait for delayed API response.','cancel')
  const start=Date.now()
  while(!pending) {if(Date.now()-start>15000)throw new Error('Cline cancellation never reached the mock');await new Promise(r=>setTimeout(r,20))}
  await agent.cancelTask('cancel');assert((await running).some(e=>e.type==='cancelled'));pending.destroy()
  mode='follow';assert.equal((await collect('Continue after cancelled turn.','recover')).at(-1)?.type,'assistant-complete')
  mode='error';events=await collect('Fail this turn.','error')
  assert(events.some(e=>e.type==='error'),JSON.stringify(events));assert(!events.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(events).includes('cline-mock-secret'))
  assert(requests.every(r=>['cline-smoke-model','different-model'].includes(r.body.model)))
  const scan=async(dir)=>{for(const e of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,e.name);if(e.isDirectory())await scan(path);else assert(!(await readFile(path)).includes(Buffer.from('cline-mock-secret')),`Credential in ${e.name}`)}}
  await scan(resolve(directory,'state'))
  console.log('Cline Core 0.0.90 original SDK smoke passed: profile/key, native read tool/return, canonical history, model isolation, cancellation/recovery, provider failure, credential-free artifacts.')
}finally{clearTimeout(timeout);await agent?.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})}
