import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const temp=await mkdtemp(join(os.tmpdir(),'talent-open-interpreter-smoke-'))
const workspace=join(temp,'repo')
const stateDir=join(temp,'state')
await mkdir(workspace,{recursive:true})
await writeFile(join(workspace,'sample.txt'),'alpha\n')
const repoRoot=resolve(fileURLToPath(new URL('../../../../../',import.meta.url)))
const configuredPython=process.env.TALENT_OPEN_INTERPRETER_PYTHON??process.env.OPEN_INTERPRETER_PYTHON
const python=configuredPython?resolve(configuredPython):resolve(repoRoot,'.talent/open-interpreter/open-interpreter-runtime/venv/bin',process.platform==='win32'?'python.exe':'python')
const key='open-interpreter-smoke-secret-19'
let mode='edit'
let requests=[]
let calls=0
const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return}
  let raw='';for await(const chunk of req)raw+=chunk
  const body=JSON.parse(raw)
  requests.push({body,authorization:req.headers.authorization,path:req.url})
  calls+=1
  if(mode==='hang')return
  if(mode==='fail'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'mock unauthorized'}}));return}
  const task=(body.messages??[]).map(m=>m.content??'').join('\n')
  let chunks
  if(mode==='edit'&&calls%2===1){
    const proof=task.includes('append second proof')?'second proof':'first proof'
    const code=`from pathlib import Path\np = Path('sample.txt')\nold = p.read_text()\np.write_text(old + '${proof}\\n')\ntry:\n    import webbrowser\n    webbrowser.open('https://example.invalid')\nexcept RuntimeError as error:\n    print('BROWSER_BLOCKED=' + str(error))\nprint('READ=' + old.strip() + '; WRITE=' + p.read_text().strip())\n`
    chunks=['```','python\n',code,'\n```']
  }else chunks=['The file has been updated and I observed its new contents.']
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'close'})
  for(const [index,content] of chunks.entries()){
    const modelChunk={id:`oi-chat-${calls}`,object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta:{...(index===0?{role:'assistant'}:{}),content},finish_reason:null}]}
    res.write(`data: ${JSON.stringify(modelChunk)}\n\n`)
  }
  res.write(`data: ${JSON.stringify({id:`oi-chat-${calls}`,object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`)
  res.end('data: [DONE]\n\n')
})
let agent
try{
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)})
  const port=server.address().port
  agent=await createAgentPackage({workspace,stateDir,env:{OI_SMOKE_KEY:key},config:{python,cancelGraceMs:800}})
  const profile={id:'oi-smoke',name:'Smoke profile',provider:'mock-compatible',model:'openai/foo',protocol:'openai-chat-completions',apiKeyEnv:'OI_SMOKE_KEY',baseUrl:`http://127.0.0.1:${port}/v1`}
  let events=await collect(agent,'first','resume-session',profile,'Read sample.txt and append first proof on its own line.')
  assert.equal(await readFile(join(workspace,'sample.txt'),'utf8'),'alpha\nfirst proof\n',`native Open Interpreter should execute file code: events=${JSON.stringify(events)} stderr=${JSON.stringify(requests.map(r=>({model:r.body.model,messages:r.body.messages}))).slice(0,3000)}`)
  assert(events.some(e=>e.type==='tool-call'&&e.name==='python'))
  assert.equal(events.filter(e=>e.type==='tool-call').length,1,'streamed native code chunks should become one complete code event')
  assert(events.some(e=>e.type==='tool-result'&&String(e.output).includes('READ=alpha')))
  assert(events.filter(e=>e.type==='tool-result').every(e=>!Object.hasOwn(e,'status')),'console output has no upstream success status')
  assert(events.some(e=>e.type==='tool-result'&&String(e.output).includes('BROWSER_BLOCKED=')))
  assert(events.some(e=>e.type==='assistant-complete'),JSON.stringify(events))
  assert(requests.length>=2)
  assert(requests.every(r=>r.authorization===`Bearer ${key}`&&r.body.model==='openai/foo'),JSON.stringify(requests.map(r=>({model:r.body.model,authorizationMatches:r.authorization===`Bearer ${key}`,path:r.path}))))
  const initialCount=requests.length
  await agent.dispose()
  agent=await createAgentPackage({workspace,stateDir,env:{OI_SMOKE_KEY:key},config:{python,cancelGraceMs:800}})
  events=await collect(agent,'second','resume-session',profile,'Using our conversation, append second proof on its own line.')
  assert.equal(await readFile(join(workspace,'sample.txt'),'utf8'),'alpha\nfirst proof\nsecond proof\n','native Open Interpreter history should resume across task processes')
  assert(events.some(e=>e.type==='assistant-complete'))
  assert(requests.slice(initialCount).some(r=>JSON.stringify(r.body.messages).includes('first proof')),'second turn should include recovered earlier conversation')

  mode='hang'
  const controller=new AbortController()
  const iterator=agent.executeTask({taskId:'cancel',sessionId:'cancel-session',model:profile,input:'Wait on the model endpoint.'},{signal:controller.signal})[Symbol.asyncIterator]()
  const before=calls
  const deadline=Date.now()+20_000
  while(Date.now()<deadline&&calls===before)await new Promise(r=>setTimeout(r,30))
  assert(calls>before,'native model request should start before cancellation')
  controller.abort()
  const cancelled=[];for await(const event of {[Symbol.asyncIterator]:()=>iterator})cancelled.push(event)
  assert(cancelled.some(e=>e.type==='cancelled'))

  mode='simple'
  events=await collect(agent,'recovered','resume-session',profile,'Continue after cancellation.')
  assert(events.some(e=>e.type==='assistant-complete'),'native runtime should recover after cancellation')
  const isolatedStart=requests.length
  events=await collect(agent,'isolated','resume-session',{...profile,model:'openai/other-model'},'Use a different model route.')
  assert(events.some(e=>e.type==='assistant-complete'))
  assert(requests.slice(isolatedStart).every(r=>r.body.model==='openai/other-model'))
  assert(requests.slice(isolatedStart).every(r=>!JSON.stringify(r.body.messages).includes('first proof')),'different model profile must isolate upstream history')

  mode='fail'
  events=await collect(agent,'failure','failure-session',profile,'Trigger an API authentication failure.')
  assert(events.some(e=>e.type==='error'),`HTTP 401 should be surfaced as error: ${JSON.stringify(events)}`)
  assert.equal(events.some(e=>e.type==='assistant-complete'),false)
  assert.equal(JSON.stringify(events).includes(key),false)
  assert.equal(requests.some(r=>JSON.stringify(r.body).includes(key)),false)
  const stateFiles=await readdir(stateDir,{recursive:true,withFileTypes:true})
  for(const entry of stateFiles.filter(item=>item.isFile())) assert.equal((await readFile(join(entry.parentPath??stateDir,entry.name),'utf8')).includes(key),false,`credential persisted in ${entry.name}`)
  console.log(`Open Interpreter Python ${'0.4.3'} smoke passed: native code execution, local file observation/edit, browser guard, exact model route, cross-instance history, route isolation, cancellation/recovery, and HTTP 401.`)
}finally{
  await agent?.dispose()
  await new Promise(resolveClose=>server.close(()=>resolveClose()))
  await rm(temp,{recursive:true,force:true})
}

async function collect(instance,taskId,sessionId,model,input){const events=[];for await(const event of instance.executeTask({taskId,sessionId,model,input}))events.push(event);return events}
