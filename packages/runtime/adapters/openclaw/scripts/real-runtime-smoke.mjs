import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-openclaw-smoke-'))
const workspace = join(temp, 'workspace'), stateDir = join(temp, 'state')
await mkdir(workspace)
await writeFile(join(workspace, 'evidence.txt'), 'NATIVE_OPENCLAW_FILE_EVIDENCE\n')
const requests = [], key = 'OPENCLAW_SMOKE_SECRET'
let mode = 'normal', toolRound = 0, agent
const server = createServer(async (req,res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw || '{}'); requests.push(body)
  assert.equal(req.headers.authorization, `Bearer ${key}`)
  if (mode === 'error') { res.writeHead(401, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:key}})); return }
  if (mode === 'hang') { res.writeHead(200, {'content-type':'text/event-stream'}); return }
  let message = { role:'assistant', content:'OPENCLAW_COMPLETED' }, finish = 'stop'
  if (toolRound++ === 0) {
    const read = body.tools?.find(t => ['read','read_file','Read'].includes(t.function?.name))
    assert(read, `actual native read tool advertised: ${body.tools?.map(t=>t.function?.name).join(',')}`)
    const field = ['path','file_path','filepath'].find(k => Object.hasOwn(read.function.parameters.properties,k))
    assert(field, 'native read tool exposes its file argument')
    message = { role:'assistant', content:null, tool_calls:[{id:'native-read',type:'function',function:{name:read.function.name,arguments:JSON.stringify({[field]:join(workspace,'evidence.txt')})}}] }; finish = 'tool_calls'
  }
  if (!body.stream) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({id:'mock',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:4,completion_tokens:4,total_tokens:8}})); return }
  res.writeHead(200,{'content-type':'text/event-stream'})
  const send = (delta, finish_reason=null) => res.write(`data: ${JSON.stringify({id:'mock',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`)
  send(message.tool_calls ? {role:'assistant',tool_calls:message.tool_calls.map((t,index)=>({...t,index}))} : message)
  send({},finish)
  res.end('data: [DONE]\n\n')
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
const profile = {id:'external-openclaw',provider:'mock',model:'explicit-openclaw-model',protocol:'openai-chat-completions',apiKeyEnv:'OPENCLAW_SMOKE_KEY',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}
const options = {workspace,stateDir,env:{OPENCLAW_SMOKE_KEY:key},config:{cancelGraceMs:1000,timeoutSeconds:30}}
const collect = async stream => {const out=[];for await(const e of stream)out.push(e);return out}
const complete = events => { if(events.some(e=>e.type==='error')) console.error(JSON.stringify(events)); assert(events.some(e=>e.type==='assistant-complete')) }
async function scan(dir) {
  for(const e of await readdir(dir,{withFileTypes:true})) { const file=join(dir,e.name); if(e.isDirectory()) await scan(file); else if(e.isFile()) assert(!(await readFile(file)).includes(Buffer.from(key)),`credential not persisted in ${file}`) }
}
const deadline = setTimeout(()=>{void agent?.dispose();server.closeAllConnections()},120000)
try {
  agent = await createAgentPackage(options)
  complete(await collect(agent.executeTask({taskId:'read',input:'Read evidence.txt with the read tool then report completion.',sessionId:'conversation',model:profile})))
  assert.equal(requests[0].model,profile.model)
  assert(requests.some(b=>b.messages?.some(m=>m.role==='tool' && JSON.stringify(m.content).includes('NATIVE_OPENCLAW_FILE_EVIDENCE'))),'real native tool result returned to model')
  await agent.dispose(); agent = await createAgentPackage(options)
  complete(await collect(agent.executeTask({taskId:'resume',input:'Continue the same history.',sessionId:'conversation',model:profile})))
  assert(requests.at(-1).messages.some(m=>m.role==='user' && JSON.stringify(m.content).includes('Read evidence.txt')),'native history survives adapter recreation')
  complete(await collect(agent.executeTask({taskId:'isolation',input:'New model route.',sessionId:'conversation',model:{...profile,model:'other-openclaw-model'}})))
  assert.equal(requests.at(-1).model,'other-openclaw-model')
  assert(!requests.at(-1).messages.some(m=>m.role==='user' && JSON.stringify(m.content).includes('Read evidence.txt')),'different model route has independent history')
  mode='hang'; const before=requests.length
  const pending=collect(agent.executeTask({taskId:'cancel',input:'Wait.',sessionId:'conversation',model:profile}))
  for(let i=0;requests.length===before && i<1200;i++) await new Promise(r=>setTimeout(r,25))
  assert(requests.length>before,'cancelled native runtime reached API')
  await agent.cancelTask('wrong-id');await agent.cancelTask('cancel')
  assert((await pending).some(e=>e.type==='cancelled'))
  mode='normal'
  complete(await collect(agent.executeTask({taskId:'recover',input:'Recover.',sessionId:'conversation',model:profile})))
  mode='error'
  const failed=await collect(agent.executeTask({taskId:'fail',input:'Report error.',sessionId:'failure',model:profile}))
  assert(failed.some(e=>e.type==='error'));assert(!failed.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(failed).includes(key))
  await scan(stateDir)
  console.log('OpenClaw official runtime: native tool/result, explicit model, persistent history, route isolation, cancellation/recovery, 401 and secret storage verified; browser disabled.')
} finally {
  clearTimeout(deadline);await agent?.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true})
}
