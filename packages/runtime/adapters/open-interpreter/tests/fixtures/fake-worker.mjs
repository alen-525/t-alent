import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
const chunks=[]
for await(const chunk of process.stdin)chunks.push(chunk)
const request=JSON.parse(Buffer.concat(chunks).toString('utf8'))
const record=process.env.OI_TEST_RECORD
if(record)await appendFile(record,JSON.stringify({request,env:{key:process.env[request.apiKeyEnv],endpoint:process.env.OPENAI_API_BASE,browser:process.env.BROWSER,inherited:process.env.ANOTHER_API_KEY}})+'\n')
const mode=process.env.OI_TEST_MODE
function emit(value){process.stdout.write(JSON.stringify(value)+'\n')}
emit({type:'session',sessionId:request.sessionKey})
if(mode==='hang') { setInterval(()=>{},1000); await new Promise(()=>{}) }
if(mode==='malformed') { emit({type:'future-event'}); process.exit(0) }
if(mode==='leak') { emit({type:'assistant-delta',text:process.env[request.apiKeyEnv],tool:{name:process.env[request.apiKeyEnv],id:process.env[request.apiKeyEnv]}}); emit({type:'complete'}); process.exit(0) }
if(mode==='error') { emit({type:'error',message:`401 ${process.env[request.apiKeyEnv]}`}); process.exit(1) }
if(mode==='complete-fail') { emit({type:'complete'}); process.exit(4) }
emit({type:'tool-call',name:'python',input:'print("ok")',callId:'one'})
emit({type:'tool-result',name:'output',output:'seen '+(request.input.includes('proof')?'proof':'task')+' '+process.env[request.apiKeyEnv],status:'success'})
emit({type:'assistant-delta',text:'Observed execution.'})
emit({type:'complete'})
