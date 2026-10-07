import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile={id:'local',name:'Local profile',provider:'compatible-mock',model:'tiny-mock',protocol:'openai-chat-completions',apiKeyEnv:'OI_PRIVATE_KEY',baseUrl:'http://127.0.0.1:9314/v1'}
const worker=new URL('./fixtures/fake-worker.mjs',import.meta.url).pathname
async function setup(t,mode) {
  const temp=await mkdtemp(join(os.tmpdir(),'talent-oi-test-')); t.after(()=>rm(temp,{recursive:true,force:true}))
  const record=join(temp,'record.jsonl')
  const options={workspace:temp,stateDir:join(temp,'state'),env:{OI_PRIVATE_KEY:'never-print-this',ANOTHER_API_KEY:'strip-me',OPENAI_API_BASE:'http://inherited.invalid/v1',OI_TEST_RECORD:record,OI_TEST_MODE:mode??''},config:{cancelGraceMs:100}}
  const runtime={command:process.execPath,args:[worker],spawnProcess(command,args,opts){return spawn(command,args,opts)}}
  return {temp,record,options,runtime}
}
async function collect(agent,taskId='one',model=profile,sessionId='conversation') { const events=[];for await(const event of agent.executeTask({taskId,sessionId,model,input:'Read sample.txt and append a proof line.'}))events.push(event);return events }

test('streams execution and redacted results with arbitrary provider label and exact external route',async t=>{
  const {options,runtime,record}=await setup(t)
  const agent=await createAgentPackageWithRuntime(options,runtime)
  const events=await collect(agent)
  await agent.dispose()
  assert(events.some(e=>e.type==='tool-call'&&e.name==='python'))
  assert(events.some(e=>e.type==='tool-result'&&e.output==='seen proof [redacted]'))
  assert(events.at(-1).type==='assistant-complete')
  assert.equal(JSON.stringify(events).includes('never-print-this'),false)
  const launch=JSON.parse((await readFile(record,'utf8')).trim())
  assert.equal(launch.request.model,'tiny-mock')
  assert.equal(launch.request.baseUrl,'http://127.0.0.1:9314/v1')
  assert.equal(launch.env.key,'never-print-this')
  assert.equal(launch.env.endpoint,'http://127.0.0.1:9314/v1')
  assert.equal(launch.env.browser,'/usr/bin/true')
  assert.equal(launch.env.inherited,undefined)
  assert.equal(JSON.stringify(launch.request).includes('never-print-this'),false)
})

test('uses isolated profile/session paths across adapter instances and fingerprints model routing',async t=>{
  const {options,runtime,record}=await setup(t)
  const a=await createAgentPackageWithRuntime(options,runtime);await collect(a,'a',profile,'same-session');await a.dispose()
  const b=await createAgentPackageWithRuntime(options,runtime);await collect(b,'b',profile,'same-session');await collect(b,'c',{...profile,model:'other-model'},'same-session');await b.dispose()
  const launches=(await readFile(record,'utf8')).trim().split('\n').map(x=>JSON.parse(x).request)
  assert.equal(launches[0].historyPath,launches[1].historyPath)
  assert.notEqual(launches[0].historyPath,launches[2].historyPath)
  assert.equal(launches[0].sessionKey,launches[1].sessionKey)
  assert.notEqual(launches[0].sessionKey,launches[2].sessionKey)
  const otherWorkspace=join(options.workspace,'elsewhere');await mkdir(otherWorkspace)
  const c=await createAgentPackageWithRuntime({...options,workspace:otherWorkspace},runtime);await collect(c,'d',profile,'same-session');await c.dispose()
  const all=(await readFile(record,'utf8')).trim().split('\n').map(x=>JSON.parse(x).request)
  assert.notEqual(all[0].historyPath,all[3].historyPath,'conversation history must be isolated by workspace')
  const d=await createAgentPackageWithRuntime(options,runtime);await collect(d,'e',{...profile,name:'Renamed display label'},'same-session');await d.dispose()
  const renamed=(await readFile(record,'utf8')).trim().split('\n').map(x=>JSON.parse(x).request)
  assert.equal(renamed[1].historyPath,renamed[4].historyPath,'profile display labels must not fork conversation history')
})

test('rejects invalid numeric and executable config instead of silently changing it',async t=>{
  const {options,runtime}=await setup(t)
  for(const config of [{cancelGraceMs:0},{cancelGraceMs:60_001},{contextWindow:0},{maxTokens:1.5},{python:''}]) {
    await assert.rejects(createAgentPackageWithRuntime({...options,config},runtime),/cancelGraceMs|contextWindow|maxTokens|python/)
  }
})

test('rejects unsupported protocol and missing key before launching worker',async t=>{
  const {options,runtime,record}=await setup(t)
  const agent=await createAgentPackageWithRuntime(options,runtime)
  assert.throws(()=>agent.executeTask({taskId:'bad',input:'x',model:{...profile,protocol:'anthropic'}}),/supports only/)
  assert.throws(()=>agent.executeTask({taskId:'bad',input:'x',model:{...profile,apiKeyEnv:'MISSING_KEY'}}),/missing/)
  await agent.dispose();await assert.rejects(readFile(record),{code:'ENOENT'})
})

test('turns auth errors into redacted failure and never completes',async t=>{
  const {options,runtime}=await setup(t,'error')
  const agent=await createAgentPackageWithRuntime(options,runtime)
  const events=await collect(agent);await agent.dispose()
  assert(events.some(e=>e.type==='error'&&e.message==='401 [redacted]'))
  assert.equal(events.some(e=>e.type==='assistant-complete'),false)
  assert.equal(JSON.stringify(events).includes('never-print-this'),false)
})

test('recursively redacts strings in arbitrary event fields',async t=>{
  const {options,runtime}=await setup(t,'leak')
  const agent=await createAgentPackageWithRuntime(options,runtime)
  const events=await collect(agent);await agent.dispose()
  assert.deepEqual(events.find(e=>e.type==='assistant-delta'),{type:'assistant-delta',text:'[redacted]',tool:{name:'[redacted]',id:'[redacted]'}})
})

test('rejects unknown events and refuses completion from nonzero worker exit',async t=>{
  for(const mode of ['malformed','complete-fail']) {
    const {options,runtime}=await setup(t,mode)
    const agent=await createAgentPackageWithRuntime(options,runtime)
    const events=await collect(agent);await agent.dispose()
    assert(events.some(e=>e.type==='error'))
    assert.equal(events.some(e=>e.type==='assistant-complete'),false)
  }
})

test('cancellation stops the worker process group',async t=>{
  const {options,runtime}=await setup(t,'hang')
  const agent=await createAgentPackageWithRuntime(options,runtime)
  const controller=new AbortController()
  const iterator=agent.executeTask({taskId:'cancel',sessionId:'cancel',input:'wait',model:profile},{signal:controller.signal})[Symbol.asyncIterator]()
  await new Promise(r=>setTimeout(r,150));controller.abort()
  const events=[];for await(const event of {[Symbol.asyncIterator]:()=>iterator})events.push(event)
  await agent.dispose()
  assert(events.some(e=>e.type==='cancelled'))
})

test('pre-cancelled task does not start a worker',async t=>{
  const {options,runtime,record}=await setup(t)
  const agent=await createAgentPackageWithRuntime(options,runtime)
  const controller=new AbortController();controller.abort()
  const events=[];for await(const e of agent.executeTask({taskId:'cancelled',input:'skip',model:profile},{signal:controller.signal}))events.push(e)
  await agent.dispose()
  assert(events.some(e=>e.type==='cancelled'))
  await assert.rejects(readFile(record),{code:'ENOENT'})
})
