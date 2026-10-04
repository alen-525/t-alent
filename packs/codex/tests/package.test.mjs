import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'
const fake=new URL('./fake-app-server.mjs',import.meta.url)
async function fixture(t,mode='success',runtimeOverrides={},config={}) {
 const root=await mkdtemp(join(tmpdir(),'codex-pack-')),workspace=join(root,'workspace'),stateDir=join(root,'state'),log=join(root,'calls.jsonl')
 await (await import('node:fs/promises')).mkdir(workspace)
 const agent=await createAgentPackageWithRuntime({workspace,stateDir,env:{PACK_PROFILE_KEY:'secret-test-value',CODEX_API_KEY:'ignored-old-key',OPENAI_API_KEY:'ignored-openai-key',PACK_CODEX_MODE:mode,PACK_CODEX_LOG:log,EXTRA_SECRET_VALUE:'quoted-\"credential'},config},{command:process.execPath,bin:fake.pathname,spawnProcess:spawn,...runtimeOverrides})
 const rawExecuteTask=agent.executeTask.bind(agent)
 agent.executeTask=(task,options)=>rawExecuteTask({...task,model:typeof task.model==='string'?profile(task.model):task.model??profile()},options)
 t.after(async()=>{await agent.dispose().catch(()=>{});await rm(root,{recursive:true,force:true})}); return {agent,executeTaskRaw:rawExecuteTask,root,workspace,stateDir,log}
}
const profile=(model='profile-model',overrides={})=>({id:'external-test',provider:'openai',model,protocol:'openai-responses',apiKeyEnv:'PACK_PROFILE_KEY',...overrides})
async function collect(iterable){const a=[];for await(const e of iterable)a.push(e);return a}
test('maps App Server tool, delta and final events without repeating streamed text',async t=>{
 const {agent,log}=await fixture(t);const events=await collect(agent.executeTask({taskId:'t1',input:'inspect',sessionId:'conversation'}))
 assert.equal(events.find(e=>e.type==='tool-call').name,'cat note.txt');assert.equal(events.find(e=>e.type==='tool-result').output,'fixture output')
 assert.deepEqual(events.filter(e=>e.type==='assistant-delta').map(e=>e.text),['hello ','world'])
 assert.deepEqual(events.slice(-2),[{type:'assistant-replace',text:'hello world'},{type:'assistant-complete'}])
 assert.equal(JSON.stringify(events).includes('secret-test-value'),false)
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(typeof calls.find(c=>c.method==='thread/start').params.cwd,'string')
 assert.equal(calls.find(c=>c.method==='turn/start').params.input[0].text,'inspect')
 assert.equal(calls.find(c=>c.method==='thread/start').params.approvalPolicy,'never')
 await agent.dispose()
})
test('forwards external profile models on new and resumed turns without querying model catalogs',async t=>{
 const {agent,log}=await fixture(t)
 await collect(agent.executeTask({taskId:'model-new',input:'new model',sessionId:'model-session',model:'explicit-task-model'}))
 await collect(agent.executeTask({taskId:'model-resume',input:'resume model',sessionId:'model-session',model:'explicit-task-model'}))
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(calls.filter(call=>call.method==='model/list').length,0)
 assert.equal(calls.some(call=>call.method==='account/login/start'),true,'task execution still authenticates normally')
 const started=calls.find(call=>call.method==='thread/start').params
 const resumed=calls.find(call=>call.method==='thread/resume').params
 const turns=calls.filter(call=>call.method==='turn/start').map(call=>call.params)
 assert.equal(started.model,'explicit-task-model');assert.equal(resumed.model,'explicit-task-model')
 assert.deepEqual(turns.map(params=>params.model),['explicit-task-model','explicit-task-model'])
 await agent.dispose()
})
test('custom Responses profile owns route, key mapping, and a separate persisted thread',async t=>{
 const {agent,executeTaskRaw,log}=await fixture(t)
 const custom={...profile('vendor-codex'),id:'vendor-a',provider:'vendor',baseUrl:'http://127.0.0.1:8123/v1'}
 await collect(executeTaskRaw({taskId:'custom-a',input:'custom',sessionId:'same-session',model:custom}))
 await collect(executeTaskRaw({taskId:'custom-b',input:'changed profile',sessionId:'same-session',model:{...custom,id:'vendor-b',baseUrl:'http://127.0.0.1:8124/v1'}}))
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
 const starts=calls.filter(call=>call.method==='thread/start').map(call=>call.params)
 assert.equal(starts.length,2)
 assert.equal(starts[0].model,'vendor-codex')
 assert.deepEqual(starts[0].config,{model_provider:'t_alent_external','model_providers.t_alent_external.name':'External Responses provider','model_providers.t_alent_external.base_url':'http://127.0.0.1:8123/v1','model_providers.t_alent_external.wire_api':'responses','model_providers.t_alent_external.env_key':'T_ALENT_MODEL_API_KEY','model_providers.t_alent_external.requires_openai_auth':false,'model_providers.t_alent_external.request_max_retries':0,'model_providers.t_alent_external.stream_max_retries':0})
 assert.throws(()=>executeTaskRaw({taskId:'bad',input:'x',model:{...custom,protocol:'anthropic'}}),/unsupported model profile protocol/)
 assert.equal(calls.some(call=>call.method==='account/login/start'),false,'custom endpoint credentials use env_key without OpenAI account login')
 await agent.dispose()
})
test('persists and resumes host session mapping',async t=>{
 const {agent,stateDir,log}=await fixture(t)
 await collect(agent.executeTask({taskId:'one',input:'first',sessionId:'host-A'}));await collect(agent.executeTask({taskId:'two',input:'second',sessionId:'host-A'}))
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.equal(calls.find(c=>c.method==='thread/resume').params.threadId,'upstream-thread-1')
 assert.equal(Object.values(JSON.parse(await readFile(join(stateDir,'codex-threads.json'),'utf8')))[0],'upstream-thread-1');await agent.dispose()
})
test('fails cleanly for missing auth, malformed rpc and failed turn',async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-no-key-'));await (await import('node:fs/promises')).mkdir(join(root,'workspace'))
 const agent=await createAgentPackageWithRuntime({workspace:join(root,'workspace'),stateDir:join(root,'state'),env:{},config:{}},{command:process.execPath,bin:fake.pathname,spawnProcess:spawn})
 assert.throws(()=>agent.executeTask({taskId:'nokey',input:'x'}),/model profile is required/);assert.throws(()=>agent.executeTask({taskId:'nokey',input:'x',model:profile()}),/PACK_PROFILE_KEY is missing/);await agent.dispose();await rm(root,{recursive:true,force:true})
 const {agent:bad}=await fixture(t,'malformed');assert.equal((await collect(bad.executeTask({taskId:'bad',input:'x'}))).filter(e=>e.type==='error').length,1);await bad.dispose()
 const {agent:failed}=await fixture(t,'failure');const events=await collect(failed.executeTask({taskId:'failed',input:'x'}));assert.match(events.find(e=>e.type==='error').message,/fixture failure \[redacted\]/);assert.equal(JSON.stringify(events).includes('secret-test-value'),false);assert.equal(events.some(e=>e.type==='assistant-complete'),false);await failed.dispose()
})
test('rejects legacy model and endpoint overrides in package config',async t=>{
 const root=await mkdtemp(join(tmpdir(),'codex-legacy-config-')),workspace=join(root,'workspace'),stateDir=join(root,'state');await (await import('node:fs/promises')).mkdir(workspace)
 for(const codexConfig of [{model:'old-model'},{model_provider:'old-provider'},{'model_providers.openai.base_url':'https://example.invalid'},{openai_base_url:'https://example.invalid'}]) await assert.rejects(createAgentPackageWithRuntime({workspace,stateDir,config:{codexConfig}},{command:process.execPath,bin:fake.pathname,spawnProcess:spawn}),/model and provider settings must come from the external model profile/)
 await rm(root,{recursive:true,force:true})
})
test('cancels only matching task, waits for App Server completion and emits one cancelled event',async t=>{
 const {agent}=await fixture(t,'slow');const stream=agent.executeTask({taskId:'slow-task',input:'wait'});const iter=stream[Symbol.asyncIterator]();const first=await iter.next();assert.equal(first.value.type,'session')
 await agent.cancelTask('wrong-task');await agent.cancelTask('slow-task');const rest=[];for await(const e of { [Symbol.asyncIterator]:()=>iter })rest.push(e)
 assert.deepEqual(rest,[{type:'cancelled'}]);await agent.dispose()
})
test('workspace program transforms input with explicit trusted hook',async t=>{
 const {agent,workspace,log,root}=await fixture(t);await writeFile(join(workspace,'program.mjs'),"export function transformInput(input){return 'rewritten: '+input}")
 await agent.dispose()
 const hooked=await createAgentPackageWithRuntime({workspace,stateDir:join(root,'state'),env:{PACK_PROFILE_KEY:'secret-test-value',PACK_CODEX_LOG:log},config:{program:'program.mjs'}},{command:process.execPath,bin:fake.pathname,spawnProcess:spawn})
 await collect(hooked.executeTask({taskId:'hook',input:'hello',model:profile()}));const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.find(c=>c.method==='turn/start').params.input[0].text,'rewritten: hello');await hooked.dispose()
})


test('fails once for malformed JSON-RPC, spawn failure, and corrupt thread maps',async t=>{
 const {agent:malformed}=await fixture(t,'null-rpc');const malformedEvents=await collect(malformed.executeTask({taskId:'null-rpc',input:'x'}));assert.equal(malformedEvents.filter(e=>e.type==='error').length,1);assert.match(malformedEvents.find(e=>e.type==='error').message,/malformed JSON-RPC/);await malformed.dispose()
 const {agent:spawnFailed}=await fixture(t,'success',{spawnProcess(){throw new Error('spawn denied secret-test-value')}});const spawnEvents=await collect(spawnFailed.executeTask({taskId:'spawn-fail',input:'x'}));assert.equal(spawnEvents.filter(e=>e.type==='error').length,1);assert.equal(JSON.stringify(spawnEvents).includes('secret-test-value'),false);await spawnFailed.dispose()
 const root=await mkdtemp(join(tmpdir(),'codex-badmap-')),workspace=join(root,'workspace'),stateDir=join(root,'state');await (await import('node:fs/promises')).mkdir(workspace);await (await import('node:fs/promises')).mkdir(stateDir);await writeFile(join(stateDir,'codex-threads.json'),'not json');await assert.rejects(createAgentPackageWithRuntime({workspace,stateDir,env:{PACK_PROFILE_KEY:'x'},config:{}},{command:process.execPath,bin:fake.pathname,spawnProcess:spawn}),/thread map is unreadable/);await rm(root,{recursive:true,force:true})
})

test('rejects overlapping work and disposal cancels the owned task',async t=>{
 const {agent}=await fixture(t,'slow');const stream=agent.executeTask({taskId:'owned',input:'wait'});const iterator=stream[Symbol.asyncIterator]();await iterator.next();assert.throws(()=>agent.executeTask({taskId:'overlap',input:'no'}),/already has active task/);await agent.dispose();const rest=[];for await(const e of { [Symbol.asyncIterator]:()=>iterator })rest.push(e);assert.deepEqual(rest,[{type:'cancelled'}]);assert.throws(()=>agent.executeTask({taskId:'disposed',input:'x'}),/disposed/)
})


test('redacts quoted credentials inside deeply nested stream events',async t=>{
 const {agent}=await fixture(t,'secret-text');const events=await collect(agent.executeTask({taskId:'quoted-secret',input:'x'}));assert.equal(JSON.stringify(events).includes('quoted-\"credential'),false);assert.ok(events.some(e=>e.type==='assistant-delta'&&e.text==='extra: [redacted]'));await agent.dispose()
})

test('declines Codex permission-profile requests with the pinned schema response',async t=>{
 const {agent,log}=await fixture(t,'permission-request');const events=await collect(agent.executeTask({taskId:'permission-request',input:'x'}));assert.ok(events.some(e=>e.type==='assistant-complete'));const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(calls.some(c=>c.id==='permission-approval'&&JSON.stringify(c.result)===JSON.stringify({permissions:{},scope:'turn'})));await agent.dispose()
})

test('cancellation interrupts an asynchronous input hook before spawn',async t=>{
 const {root,workspace,stateDir}=await fixture(t);await writeFile(join(workspace,'hang.mjs'),"export function transformInput(){return new Promise(()=>{})}");const agent=await createAgentPackageWithRuntime({workspace,stateDir,env:{PACK_PROFILE_KEY:'quoted-\"credential'},config:{program:'hang.mjs'}},{command:process.execPath,bin:fake.pathname,spawnProcess(){throw new Error('must not spawn')}});const stream=agent.executeTask({taskId:'hook-cancel',input:'wait',model:profile()});const events=collect(stream);await agent.cancelTask('hook-cancel');assert.deepEqual(await events,[{type:'cancelled'}]);await agent.dispose()
})
