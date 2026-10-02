import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
const mode=process.env.PACK_CODEX_MODE??'success', log=process.env.PACK_CODEX_LOG
const rl=createInterface({input:process.stdin})
const send=v=>process.stdout.write(JSON.stringify(v)+'\n')
rl.on('line',line=>{
 let m; try{m=JSON.parse(line)}catch{return}
 if(log)appendFileSync(log,JSON.stringify(m)+'\n')
 if(m.id==='permission-approval'&&m.result){send({method:'item/agentMessage/delta',params:{delta:'permission request declined safely'}});send({method:'turn/completed',params:{threadId:'upstream-thread-1',turn:{id:'turn-1',status:'completed'}}});return}
  if(m.id!==undefined){
  if(m.method==='initialize'){send({id:m.id,result:{serverInfo:{name:'fake',version:'0'}}});return}
  if(m.method==='model/list'){if(mode==='catalog-slow')return;if(log)appendFileSync(log,JSON.stringify({catalogEnvHasApiKey:Boolean(process.env.CODEX_API_KEY||process.env.OPENAI_API_KEY)})+'\n');send({id:m.id,result:{data:[{id:'picker-id',model:'catalog-model',displayName:'Catalog Model',description:'fixture model',hidden:false,isDefault:true}],nextCursor:null}});return}
  if(m.method==='account/login/start'){send({id:m.id,result:{}});return}
  if(m.method==='thread/start'||m.method==='thread/resume'){send({id:m.id,result:{thread:{id:'upstream-thread-1'}}});return}
  if(m.method==='turn/start'){
   send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}})
   if(mode==='malformed'){process.stdout.write('{invalid json}\n');return}
   if(mode==='null-rpc'){process.stdout.write('null\n');return}
   if(mode==='failure'){send({method:'turn/completed',params:{threadId:'upstream-thread-1',turn:{id:'turn-1',status:'failed',error:{message:'fixture failure secret-test-value'}}}});return}
   if(mode==='slow')return
   if(mode==='secret-text'){send({method:'item/agentMessage/delta',params:{delta:`extra: ${process.env.EXTRA_SECRET_VALUE}`}});send({method:'turn/completed',params:{threadId:'upstream-thread-1',turn:{id:'turn-1',status:'completed'}}});return}
   if(mode==='permission-request'){send({id:'permission-approval',method:'item/permissions/requestApproval',params:{threadId:'upstream-thread-1',turnId:'turn-1',reason:'fixture'}});return}
   send({method:'item/started',params:{item:{id:'call-1',type:'commandExecution',command:'cat note.txt'}}})
   send({method:'item/completed',params:{item:{id:'call-1',type:'commandExecution',command:'cat note.txt',exitCode:0,aggregatedOutput:'fixture output'}}})
   send({method:'item/agentMessage/delta',params:{delta:'hello '}})
   send({method:'item/agentMessage/delta',params:{delta:'world'}})
   send({method:'item/completed',params:{item:{id:'msg-1',type:'agentMessage',text:'hello world'}}})
   send({method:'turn/completed',params:{threadId:'upstream-thread-1',turn:{id:'turn-1',status:'completed'}}})
   return
  }
  if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'upstream-thread-1',turn:{id:'turn-1',status:'interrupted'}}});return}
  send({id:m.id,error:{code:-32601,message:'unknown method'}})
 }
})
