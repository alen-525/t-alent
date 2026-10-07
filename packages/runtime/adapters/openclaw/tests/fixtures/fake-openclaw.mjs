import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag)+1]
const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH,'utf8'))
const input = await readFile(get('--message-file'),'utf8'), sessionId = get('--session-id')
const historyPath = join(process.env.OPENCLAW_STATE_DIR,'history.json')
let history = [];try {history=JSON.parse(await readFile(historyPath,'utf8'))}catch{}
await mkdir(process.env.OPENCLAW_STATE_DIR,{recursive:true})
await writeFile(process.env.TEST_OPENCLAW_CAPTURE,JSON.stringify({args,config,input,sessionId,state:process.env.OPENCLAW_STATE_DIR,history,key:process.env.TALENT_OPENCLAW_MODEL_KEY,browser:process.env.BROWSER}))
if(input==='HANG'){setInterval(()=>{},1000);await new Promise(()=>{})}
if(input==='FAIL'){console.error(process.env.TALENT_OPENCLAW_MODEL_KEY);process.exit(1)}
if(input==='MALFORMED'){console.log('not JSON');process.exit(0)}
await writeFile(historyPath,JSON.stringify([...history,input]))
console.log(JSON.stringify({payloads:[{text:`result ${process.env.TALENT_OPENCLAW_MODEL_KEY}`}],meta:{agentMeta:{sessionId},...(input==='NATIVEERROR'?{error:{message:process.env.TALENT_OPENCLAW_MODEL_KEY}}:{})}}))
