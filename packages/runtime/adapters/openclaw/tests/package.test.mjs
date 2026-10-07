import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackageWithRuntime } from '../src/index.mjs'
const profile = (extra={}) => ({id:'external',provider:'mock',model:'explicit-model',protocol:'openai-chat-completions',apiKeyEnv:'OPENAI_API_KEY',baseUrl:'http://127.0.0.1:1234/v1',...extra})
const collect = async stream => {const out=[];for await(const e of stream)out.push(e);return out}
async function fixture(t,extra={}) {
 const root=await mkdtemp(join(tmpdir(),'talent-openclaw-unit-')),capture=join(root,'capture.json')
 const options={workspace:root,stateDir:join(root,'state'),env:{OPENAI_API_KEY:'selected-secret',TEST_OPENCLAW_CAPTURE:capture,OPENCLAW_CONFIG_PATH:'ignored-global',OPENCLAW_STATE_DIR:'ignored-state'},config:{cancelGraceMs:50}}
 const runtime={command:process.execPath,bin:new URL('./fixtures/fake-openclaw.mjs',import.meta.url).pathname,spawnProcess:spawn,...extra}
 const agent=await createAgentPackageWithRuntime(options,runtime)
 t.after(async()=>{await agent.dispose();await rm(root,{recursive:true,force:true})})
 return {agent,root,capture,options,runtime}
}
test('routes exact host profile with an environment SecretRef and disables browser and automatic update',async t=>{
 const {agent,capture}=await fixture(t)
 const events=await collect(agent.executeTask({taskId:'one',input:'hello',sessionId:'chat',model:profile()}))
 assert(events.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(events).includes('selected-secret'))
 const record=JSON.parse(await readFile(capture,'utf8')),provider=record.config.models.providers.talent
 assert.equal(provider.api,'openai-completions');assert.equal(provider.baseUrl,profile().baseUrl);assert.equal(provider.models[0].id,profile().model)
 assert.deepEqual(provider.apiKey,{source:'env',provider:'default',id:'TALENT_OPENCLAW_MODEL_KEY'})
 assert.equal(provider.agentRuntime.id,'openclaw');assert.deepEqual(record.config.agents.defaults.model.fallbacks,[])
 assert.equal(record.config.browser.enabled,false);assert(record.config.tools.deny.includes('group:ui'));assert.equal(record.browser,'/usr/bin/true')
 assert.equal(record.config.update.auto.enabled,false);assert.equal(record.key,'selected-secret')
 assert(!JSON.stringify(record.args).includes('selected-secret'));assert(!JSON.stringify(record.config).includes('selected-secret'))
 assert(record.args.includes('--local'));assert(!record.args.includes('--deliver'))
})
test('native session resumes across instances and isolates changed model profiles and conversations',async t=>{
 const f=await fixture(t)
 await collect(f.agent.executeTask({taskId:'one',input:'first',sessionId:'chat',model:profile()}))
 const first=JSON.parse(await readFile(f.capture,'utf8'));await f.agent.dispose()
 const next=await createAgentPackageWithRuntime(f.options,f.runtime);t.after(()=>next.dispose())
 await collect(next.executeTask({taskId:'two',input:'second',sessionId:'chat',model:profile()}))
 const second=JSON.parse(await readFile(f.capture,'utf8'));assert.equal(first.sessionId,second.sessionId);assert.deepEqual(second.history,['first'])
 for(const [sessionId,model] of [['other',profile()],['chat',profile({model:'other-model'})]]) {
  await collect(next.executeTask({taskId:'new',input:'isolated',sessionId,model}))
  const isolated=JSON.parse(await readFile(f.capture,'utf8'));assert.notEqual(isolated.state,first.state);assert.deepEqual(isolated.history,[])
 }
})
test('invalid profiles, native failure and malformed results cannot complete and errors redact credentials',async t=>{
 const {agent,options,runtime}=await fixture(t)
 for(const model of [undefined,profile({protocol:'google-generative-ai'}),profile({baseUrl:'https://user:pass@example.com'}),profile({apiKeyEnv:'MISSING_KEY'})]) assert.throws(()=>agent.executeTask({taskId:'bad',input:'x',model}),/profile|protocol|baseUrl|API key/)
 await assert.rejects(createAgentPackageWithRuntime({...options,config:{model:'forbidden'}},runtime),/routing comes from the host/)
 for(const input of ['FAIL','MALFORMED','NATIVEERROR']) {
  const events=await collect(agent.executeTask({taskId:input,input,model:profile()}))
  assert(events.some(e=>e.type==='error'));assert(!events.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(events).includes('selected-secret'))
 }
})
test('cancellation is scoped to the running child and startup cancellation never spawns',async t=>{
 const {agent,capture}=await fixture(t)
 const pending=collect(agent.executeTask({taskId:'hang',input:'HANG',model:profile()}))
 let started=false
 for(let i=0;i<200;i++){try{started=JSON.parse(await readFile(capture,'utf8')).input==='HANG'}catch{}if(started)break;await new Promise(r=>setTimeout(r,10))}
 assert(started);await agent.cancelTask('wrong-id');await agent.cancelTask('hang');assert((await pending).some(e=>e.type==='cancelled'))
 assert((await collect(agent.executeTask({taskId:'recovery',input:'ok',model:profile()}))).some(e=>e.type==='assistant-complete'))
 let ready,release,spawned=false
 const entered=new Promise(r=>{ready=r}),gate=new Promise(r=>{release=r})
 const f=await fixture(t,{beforeSpawn:async()=>{ready();await gate},spawnProcess(){spawned=true;throw new Error('must not spawn')}})
 const preparing=collect(f.agent.executeTask({taskId:'preparing',input:'ok',model:profile()}))
 await entered;const cancelled=f.agent.cancelTask('preparing');release();await cancelled
 assert.equal(spawned,false);assert((await preparing).some(e=>e.type==='cancelled'))
})
