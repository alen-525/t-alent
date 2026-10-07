import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
const version='1.15.23'
const wheels=[
 {name:'crewai',file:'crewai-1.15.23-py3-none-any.whl',url:'https://files.pythonhosted.org/packages/84/80/bfb12ca66eb3cb195a83ad92bc9c8ff3193192da9d9de3a6c22256e9e49c/crewai-1.15.23-py3-none-any.whl',sha256:'d7ca47f2adc6011be0ecb1a1bb855055282d621959bae4ad8347b52eb21d06d2'},
 {name:'crewai-tools',file:'crewai_tools-1.15.23-py3-none-any.whl',url:'https://files.pythonhosted.org/packages/67/d2/76b9e5521119264b506fe40e68f2758e0aa5080b2d9c2de6cd8b672b3b41/crewai_tools-1.15.23-py3-none-any.whl',sha256:'c22409799ce2824d9d99a4190613c69883d6c99677e683a89aa696576a75337e'}]
let stateDir=process.env.TALENT_STATE_DIR, basePython=process.env.TALENT_CREWAI_PYTHON||process.env.TALENT_PYTHON||'python3'
for(let i=2;i<process.argv.length;i++){if(process.argv[i]==='--state-dir')stateDir=process.argv[++i];else if(process.argv[i]==='--python')basePython=process.argv[++i];else throw Error(`Unknown option ${process.argv[i]}`)}
if(!stateDir)throw Error('Pass --state-dir <state-dir> or set TALENT_STATE_DIR')
const dest=resolve(stateDir,'crewai-runtime'),venv=join(dest,'venv'),python=process.platform==='win32'?join(venv,'Scripts/python.exe'):join(venv,'bin/python'),temp=await mkdtemp(join(tmpdir(),'talent-crewai-'))
try {
 const py=await capture(basePython,['-c','import sys; print(".".join(map(str,sys.version_info[:3]))); sys.exit(0 if (3,10)<=sys.version_info[:2]<(3,14) else 1)'])
 const files=[]
 for(const w of wheels){const r=await fetch(w.url,{redirect:'error'});if(!r.ok)throw Error(`Download ${w.name} failed: HTTP ${r.status}`);const b=Buffer.from(await r.arrayBuffer()),sum=createHash('sha256').update(b).digest('hex');if(sum!==w.sha256)throw Error(`${w.name} SHA256 mismatch: ${sum}`);const p=join(temp,w.file);await writeFile(p,b,{mode:0o600});files.push(p)}
 await mkdir(dest,{recursive:true,mode:0o700});await rm(venv,{recursive:true,force:true});await run(basePython,['-m','venv',venv]);await run(python,['-m','pip','install','--disable-pip-version-check',...files])
 const installed=(await capture(python,['-c','import importlib.metadata as m; from crewai_tools import FileReadTool, FileWriterTool; print(m.version("crewai")); print(m.version("crewai-tools"))'])).trim().split(/\s+/);if(installed.some(v=>v!==version))throw Error(`Unexpected CrewAI versions: ${installed.join(',')}`)
 const resolvedPackages=(await capture(python,['-m','pip','freeze','--all'])).trim().split(/\r?\n/).filter(Boolean)
 await writeFile(join(dest,'runtime.json'),JSON.stringify({python:py.trim(),pythonExecutable:python,packages:installed,resolvedPackages,wheels:wheels.map(({name,url,sha256})=>({name,url,sha256}))},null,2)+'\n',{mode:0o600});console.log(`Installed CrewAI ${version} and native file tools in ${venv}`)
}finally{await rm(temp,{recursive:true,force:true})}
function run(cmd,args){return new Promise((ok,fail)=>{const c=spawn(cmd,args,{stdio:'inherit',shell:false,env:clean(process.env)});c.once('error',fail);c.once('close',n=>n===0?ok():fail(Error(`${cmd} failed (${n})`)))})}
function capture(cmd,args){return new Promise((ok,fail)=>{const c=spawn(cmd,args,{stdio:['ignore','pipe','pipe'],shell:false,env:clean(process.env)});let s='';c.stdout.on('data',x=>s+=x);c.stderr.on('data',x=>s+=x);c.once('error',fail);c.once('close',n=>n===0?ok(s):fail(Error(s.slice(-3000))))})}
function clean(env){const e={...env};for(const k of Object.keys(e))if(/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))delete e[k];return e}
