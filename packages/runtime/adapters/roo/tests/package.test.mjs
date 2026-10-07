import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentPackageWithRuntime } from '../src/index.mjs'

const profile={id:'test',name:'Test',provider:'external',model:'arbitrary/id:exact',protocol:'openai-chat-completions',apiKeyEnv:'ROO_TEST_KEY',baseUrl:'http://127.0.0.1:9999/v1'}
test('validates host profile before launching Roo',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'roo-adapter-test-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const agent=await createAgentPackageWithRuntime({workspace:temp,stateDir:join(temp,'state'),env:{},config:{}},{command:'/missing/roo',spawnProcess(){throw new Error('must not spawn')}})
 assert.throws(()=>agent.executeTask({taskId:'x',input:'y',model:{...profile,protocol:'anthropic'}}),/unsupported model profile protocol/)
 assert.throws(()=>agent.executeTask({taskId:'x',input:'y',model:profile}),/ROO_TEST_KEY is missing/)
 await agent.dispose()
})
