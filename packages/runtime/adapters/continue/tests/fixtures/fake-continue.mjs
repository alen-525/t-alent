import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
const args=process.argv.slice(2)
const config=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'))
let input='';for await(const chunk of process.stdin) input+=chunk
await writeFile(process.env.TEST_CONTINUE_CAPTURE,JSON.stringify({args,config,key:process.env.TALENT_CONTINUE_MODEL_KEY,dir:process.env.CONTINUE_GLOBAL_DIR,input}))
if(input==='HANG') {process.stdout.write('STARTED\n'); setInterval(()=>{},1000); await new Promise(()=>{})}
else if(input==='FAIL') {process.stderr.write(`upstream rejected ${process.env.TALENT_CONTINUE_MODEL_KEY}`);process.exitCode=1}
else if(input==='NOSESSION') process.stdout.write('fake success without native history\n')
else {
 const dir=join(process.env.CONTINUE_GLOBAL_DIR,'sessions');await mkdir(dir,{recursive:true})
 const file=join(dir,'native-fixture.json')
 let history=[];try{history=JSON.parse(await readFile(file,'utf8')).history}catch{}
 history.push({message:{role:'user',content:input}},{message:{role:'assistant',content:'native reply'}})
 await writeFile(file,JSON.stringify({sessionId:'native-fixture',history}))
 process.stdout.write(`native reply ${process.env.TALENT_CONTINUE_MODEL_KEY}\n`)
}
