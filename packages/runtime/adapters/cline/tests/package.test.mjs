import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createAgentPackageWithRuntime} from '../src/index.mjs'
const profile={id:'test',provider:'company',model:'test-model',protocol:'openai-chat-completions',apiKeyEnv:'MODEL_CREDENTIAL',baseUrl:'http://127.0.0.1:9999/v1'}
const runtime={command:process.execPath,bin:fileURLToPath(new URL('./fake-worker.mjs',import.meta.url)),spawnProcess:spawn}
const collect=async(iterable)=>{const out=[];for await(const e of iterable)out.push(e);return out}
const task=(input='hello',extra={})=>({taskId:'t',sessionId:'s',input,model:profile,...extra})
async function setup(t) {
  const dir=await mkdtemp(resolve(tmpdir(),'talent-cline-test-'))
  const options={workspace:dir,stateDir:resolve(dir,'state'),env:{MODEL_CREDENTIAL:'cline-test-secret',TEST_CAPTURE:resolve(dir,'capture.json')},config:{cancelGraceMs:100}}
  const agent=await createAgentPackageWithRuntime(options,runtime)
  t.after(async()=>{await agent.dispose();await rm(dir,{recursive:true,force:true})})
  return {agent,dir,options}
}
test('isolates worker state by conversation/profile and keeps credentials out of job JSON',async t=>{
  const {agent,dir}=await setup(t)
  assert.equal((await collect(agent.executeTask(task()))).at(-1).type,'assistant-complete')
  const first=JSON.parse(await readFile(resolve(dir,'capture.json'),'utf8'))
  assert.equal(first.key,'cline-test-secret');assert(!JSON.stringify(first.job).includes('cline-test-secret'));assert.equal(first.job.profile.model,'test-model')
  await collect(agent.executeTask(task('follow',{taskId:'next'})))
  assert.equal(JSON.parse(await readFile(resolve(dir,'capture.json'),'utf8')).job.stateDir,first.job.stateDir)
  await collect(agent.executeTask(task('fresh',{taskId:'different',model:{...profile,model:'other-model'}})))
  assert.notEqual(JSON.parse(await readFile(resolve(dir,'capture.json'),'utf8')).job.stateDir,first.job.stateDir)
})
test('rejects missing/unsupported profiles, credential URL, missing key, and package model config',async t=>{
  const {agent,options}=await setup(t)
  assert.throws(()=>agent.executeTask(task('hi',{model:undefined})),/profile/)
  assert.throws(()=>agent.executeTask(task('hi',{model:{...profile,protocol:'anthropic'}})),/protocol/)
  assert.throws(()=>agent.executeTask(task('hi',{model:{...profile,baseUrl:'https://user:pass@host'}})),/baseUrl/)
  assert.throws(()=>agent.executeTask(task('hi',{model:{...profile,apiKeyEnv:'MISSING_PROFILE_CREDENTIAL'}})),/Missing/)
  await assert.rejects(createAgentPackageWithRuntime({...options,config:{model:'implicit'}},runtime),/profile/)
})
test('worker failures do not complete and emitted credential diagnostics are redacted',async t=>{
  const {agent}=await setup(t)
  for(const input of ['bad','error']){const events=await collect(agent.executeTask(task(input)));assert(events.some(e=>e.type==='error'));assert(!events.some(e=>e.type==='assistant-complete'));assert(!JSON.stringify(events).includes('cline-test-secret'))}
})
test('pre-abort, scoped cancel, iterator return, and dispose stop subprocesses',async t=>{
  const {agent}=await setup(t)
  const controller=new AbortController();controller.abort()
  assert.deepEqual(await collect(agent.executeTask(task(),{signal:controller.signal})),[{type:'cancelled'}])
  const iterator=agent.executeTask(task('stall'))[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type,'session');assert.throws(()=>agent.executeTask(task()),/active/)
  await agent.cancelTask('wrong');await agent.cancelTask('t');assert.equal((await iterator.next()).value.type,'cancelled');assert((await iterator.next()).done)
  const early=agent.executeTask(task('stall'))[Symbol.asyncIterator]();await early.next();await early.return()
  assert.equal((await collect(agent.executeTask(task()))).at(-1).type,'assistant-complete')
  await agent.dispose();assert.throws(()=>agent.executeTask(task()),/disposed/)
})
