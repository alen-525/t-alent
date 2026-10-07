import { writeFile } from 'node:fs/promises'
let raw='';for await(const c of process.stdin)raw+=c
const job=JSON.parse(raw)
const send=e=>process.stdout.write(JSON.stringify(e)+'\n')
if(process.env.TEST_CAPTURE)await writeFile(process.env.TEST_CAPTURE,JSON.stringify({job,key:process.env.TALENT_CLINE_KEY,home:process.env.HOME}))
send({type:'session',sessionId:'cline-test-session'})
if(job.input==='stall')setInterval(()=>{},1000)
else if(job.input==='bad')process.stdout.write('not json\n')
else if(job.input==='error')send({type:'error',message:`bad ${process.env.TALENT_CLINE_KEY}`})
else {send({type:'tool-call',name:'read_files',input:{paths:['fixture.txt']}});send({type:'tool-result',name:'read_files',output:'fixture'});send({type:'assistant-replace',text:'OK'});send({type:'assistant-complete'})}
