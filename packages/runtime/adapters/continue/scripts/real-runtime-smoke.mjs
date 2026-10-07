import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-continue-smoke-'))
const workspace = join(temp, 'workspace'), stateDir = join(temp, 'state')
await mkdir(workspace)
await writeFile(join(workspace, 'evidence.txt'), 'NATIVE_CONTINUE_FILE_EVIDENCE\n')
const requests = []
let mode = 'normal', modelReceived, toolRound = 0
const server = createServer(async (req,res) => {
  let raw=''; for await (const chunk of req) raw+=chunk
  const body=JSON.parse(raw || '{}'); requests.push(body); modelReceived=body.model
  if (mode === 'error') { res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'REJECTED_CONTINUE_KEY'}})); return }
  if (mode === 'hang') { res.writeHead(200,{'content-type':'text/event-stream'}); return }
  if (!body.stream) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({id:'title',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'Continue smoke'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})); return }
  res.writeHead(200,{'content-type':'text/event-stream'})
  const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'smoke',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`)
  if (toolRound++===0) {
    assert(body.tools.some(t=>t.function.name==='Read'),'actual Continue native Read tool advertised')
    send({role:'assistant',tool_calls:[{index:0,id:'native-read',type:'function',function:{name:'Read',arguments:JSON.stringify({filepath:join(workspace,'evidence.txt')})}}]})
    send({},'tool_calls')
  } else { send({role:'assistant',content:'CONTINUE_COMPLETED'}); send({},'stop') }
  res.end('data: [DONE]\n\n')
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const profile={id:'external-continue',provider:'mock',model:'explicit-continue-model',protocol:'openai-chat-completions',apiKeyEnv:'CONTINUE_SMOKE_KEY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}
const options={workspace,stateDir,env:{CONTINUE_SMOKE_KEY:'REJECTED_CONTINUE_KEY'},config:{cancelGraceMs:200}}
const collect=async stream=>{const out=[];for await(const event of stream)out.push(event);return out}
let agent
try {
  agent=await createAgentPackage(options)
  const first=await collect(agent.executeTask({taskId:'read',input:'Read evidence.txt with the Read tool then report completion.',sessionId:'conversation',model:profile}))
  if(first.some(e=>e.type==='error')) console.error(JSON.stringify(first))
  assert(first.some(e=>e.type==='assistant-complete'))
  assert.equal(modelReceived,profile.model)
  assert(requests.some(b=>b.messages?.some(m=>m.role==='tool' && JSON.stringify(m.content).includes('NATIVE_CONTINUE_FILE_EVIDENCE'))),'real file result returned to model')
  assert(first.some(e=>e.type==='tool-call' && e.name==='Read'))
  await agent.dispose(); agent=await createAgentPackage(options)
  const second=await collect(agent.executeTask({taskId:'resume',input:'Continue the same history.',sessionId:'conversation',model:profile}))
  assert(second.some(e=>e.type==='assistant-complete'))
  assert(requests.at(-1).messages.some(m=>m.role==='user' && JSON.stringify(m.content).includes('Read evidence.txt')))
  const historyCount=requests.at(-1).messages.length
  await collect(agent.executeTask({taskId:'isolated',input:'Start another conversation.',sessionId:'other',model:profile}))
  assert(requests.at(-1).messages.length<historyCount)
  mode='hang'
  const before=requests.length
  const pending=collect(agent.executeTask({taskId:'cancel',input:'Wait.',sessionId:'conversation',model:profile}))
  for(let i=0;requests.length===before && i<200;i++) await new Promise(r=>setTimeout(r,25))
  assert(requests.length>before,'cancelled actual runtime reached the local API')
  await agent.cancelTask('wrong-id')
  await agent.cancelTask('cancel')
  assert((await pending).some(e=>e.type==='cancelled'))
  mode='normal'
  assert((await collect(agent.executeTask({taskId:'recovered',input:'Recover after cancellation.',sessionId:'conversation',model:profile}))).some(e=>e.type==='assistant-complete'))
  mode='error'
  const failed=await collect(agent.executeTask({taskId:'failed',input:'Report authentication failure.',sessionId:'error',model:profile}))
  assert(failed.some(e=>e.type==='error'))
  assert(!failed.some(e=>e.type==='assistant-complete'))
  assert(!JSON.stringify(failed).includes('REJECTED_CONTINUE_KEY'))
  console.log('Continue official runtime: native tool/result, explicit model, cross-instance history, isolation, cancellation/recovery and 401 verified.')
} finally {
  await agent?.dispose()
  server.closeAllConnections()
  await new Promise(r=>server.close(r))
  await rm(temp,{recursive:true,force:true})
}
