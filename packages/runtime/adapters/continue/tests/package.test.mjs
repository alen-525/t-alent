import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackageWithRuntime } from '../src/index.mjs'
const profile=(extra={})=>({id:'external',provider:'label',model:'explicit-model',protocol:'openai-chat-completions',apiKeyEnv:'OPENAI_API_KEY',baseUrl:'http://127.0.0.1:1234/v1',...extra})
const collect=async stream=>{const out=[];for await(const e of stream)out.push(e);return out}
async function fixture(t,extra={}) {
 const root=await mkdtemp(join(tmpdir(),'talent-continue-unit-')),capture=join(root,'capture.json')
 const options={workspace:root,stateDir:join(root,'state'),env:{OPENAI_API_KEY:'selected-secret',TEST_CONTINUE_CAPTURE:capture,CONTINUE_GLOBAL_DIR:'ignored-global',ANTHROPIC_API_KEY:'ignored-key'},config:{cancelGraceMs:50}}
 const runtime={command:process.execPath,bin:new URL('./fixtures/fake-continue.mjs',import.meta.url).pathname,spawnProcess:spawn,...extra}
 const agent=await createAgentPackageWithRuntime(options,runtime)
 t.after(async()=>{await agent.dispose();await rm(root,{recursive:true,force:true})})
 return {agent,root,capture,options,runtime}
}
test('routes host model using secret reference and isolates native configuration without persisting the key',async t=>{
 const {agent,capture}=await fixture(t)
 const result=await collect(agent.executeTask({taskId:'one',input:'hello',sessionId:'chat',model:profile()}))
 assert(result.some(e=>e.type==='assistant-complete'))
 assert(!JSON.stringify(result).includes('selected-secret'))
 const record=JSON.parse(await readFile(capture,'utf8'))
 assert.equal(record.config.models[0].provider,'openai');assert.equal(record.config.models[0].model,'explicit-model')
 assert.equal(record.config.models[0].apiBase,profile().baseUrl)
 assert.equal(record.config.models[0].apiKey,'${{ secrets.TALENT_CONTINUE_MODEL_KEY }}')
 assert(!JSON.stringify(record.args).includes('selected-secret'))
 assert.equal(record.key,'selected-secret');assert(record.dir.includes('/state/conversations/'))
 assert(!JSON.stringify(record.config).includes('selected-secret'))
})
test('resumes native history across instances and isolates model and host conversations',async t=>{
 const f=await fixture(t)
 await collect(f.agent.executeTask({taskId:'one',input:'first',sessionId:'chat',model:profile()}))
 const first=JSON.parse(await readFile(f.capture,'utf8'))
 await f.agent.dispose()
 const next=await createAgentPackageWithRuntime(f.options,f.runtime);t.after(()=>next.dispose())
 await collect(next.executeTask({taskId:'two',input:'second',sessionId:'chat',model:profile()}))
 const second=JSON.parse(await readFile(f.capture,'utf8'))
 assert(second.args.includes('--resume'));assert.equal(first.dir,second.dir)
 for(const [sessionId,model] of [['other',profile()],['chat',profile({model:'different'})]]) {
  await collect(next.executeTask({taskId:sessionId+model.model,input:'isolated',sessionId,model}))
  const isolated=JSON.parse(await readFile(f.capture,'utf8'))
  assert(!isolated.args.includes('--resume'));assert.notEqual(isolated.dir,first.dir)
 }
})
test('rejects missing or incompatible profiles, unsupported behavior config, bad endpoint and malformed completion',async t=>{
 const {agent,options,runtime}=await fixture(t)
 for(const model of [undefined,profile({protocol:'openai-responses'}),profile({baseUrl:'https://user:pass@example.com'}),profile({apiKeyEnv:'MISSING_MODEL_KEY'})]) assert.throws(()=>agent.executeTask({taskId:'bad',input:'x',model}),/profile|protocol|baseUrl|API key/)
 await assert.rejects(createAgentPackageWithRuntime({...options,config:{model:'forbidden'}},runtime),/routing comes from the host/)
 for(const input of ['FAIL','NOSESSION']) {
  const failed=await collect(agent.executeTask({taskId:input,input,model:profile()}))
  assert(failed.some(e=>e.type==='error'));assert(!failed.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(failed).includes('selected-secret'))
 }
})
test('cancellation is scoped, stops the actual child, iterator return releases it and permits the next task',async t=>{
 const {agent,capture}=await fixture(t)
 const stream=agent.executeTask({taskId:'hang',input:'HANG',model:profile()})
 const pending=collect(stream)
 let started=false
 for(let i=0;i<200;i++){try{started=JSON.parse(await readFile(capture,'utf8')).input==='HANG'}catch{} if(started)break;await new Promise(r=>setTimeout(r,10))}
 assert(started,'the actual child reached its blocking task')
 await agent.cancelTask('wrong-id')
 let ended=false;pending.then(()=>{ended=true});await new Promise(r=>setTimeout(r,10));assert.equal(ended,false)
 await agent.cancelTask('hang');assert((await pending).some(e=>e.type==='cancelled'))
 assert((await collect(agent.executeTask({taskId:'next',input:'ok',model:profile()}))).some(e=>e.type==='assistant-complete'))
 const iterable=agent.executeTask({taskId:'return',input:'ok',model:profile()})[Symbol.asyncIterator]()
 await iterable.next();await iterable.return()
 await agent.dispose();assert.throws(()=>agent.executeTask({taskId:'disposed',input:'x',model:profile()}),/disposed/)
})
test('abort during asynchronous preparation never launches a process',async t=>{
 let ready,release,spawned=false
 const entered=new Promise(r=>{ready=r}),gate=new Promise(r=>{release=r})
 const f=await fixture(t,{beforeSpawn:async()=>{ready();await gate},spawnProcess(){spawned=true;throw new Error('must not spawn')}})
 const pending=collect(f.agent.executeTask({taskId:'preparing',input:'x',model:profile()}))
 await entered;const cancel=f.agent.cancelTask('preparing');release();await cancel
 assert.equal(spawned,false);assert((await pending).some(e=>e.type==='cancelled'))
})
