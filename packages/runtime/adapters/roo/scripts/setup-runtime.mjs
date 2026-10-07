import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { posix } from 'node:path'

const execFile = promisify(execFileCb)
const version = '0.1.17'
const digest = 'cf3c1612cd6cd1e50d3db005548a071a634f17a62ca8e8b1ead5a6e832763537'
let stateDir = process.env.TALENT_STATE_DIR
let cachedArchive
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--state-dir') stateDir = process.argv[++i]
  else if (process.argv[i] === '--archive') cachedArchive = process.argv[++i]
  else throw new Error(`Unknown option ${process.argv[i]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <path> or set TALENT_STATE_DIR')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Pinned Roo CLI setup supports darwin-arm64 only; install a verified matching binary manually and set ROO_BIN.')
const url = `https://github.com/RooCodeInc/Roo-Code/releases/download/cli-v${version}/roo-cli-darwin-arm64.tar.gz`
const temp = await mkdtemp(join(tmpdir(),'talent-roo-'))
try {
  let bytes
  if (cachedArchive) bytes = await readFile(resolve(cachedArchive))
  else {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`Roo release download failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) throw new Error(`Roo archive SHA-256 mismatch: ${actual}`)
  const archive = join(temp,'roo.tar.gz'), extract = join(temp,'extract'); await writeFile(archive,bytes,{mode:0o600}); await mkdir(extract)
  validateArchive(bytes)
  await execFile('tar',['-xzf',archive,'-C',extract],{timeout:60000})
  const source = join(extract,'roo-cli-darwin-arm64')
  const destination = resolve(stateDir,'roo-runtime','roo-cli-darwin-arm64')
  await mkdir(dirname(destination),{recursive:true}); await rm(destination,{recursive:true,force:true})
  await execFile('cp',['-R',source,destination])
  const require = createRequire(import.meta.url)
  const dependencies=['@trpc/client','commander','p-wait-for','react','superjson']
  const packagePaths=new Map()
  for (const name of dependencies) {
    let entry
    try { entry=require.resolve(name) } catch { throw new Error(`Roo adapter dependency ${name} is not installed. Install this adapter package with npm before setting up the Roo runtime.`) }
    let cursor=dirname(entry)
    while (dirname(cursor)!==cursor && cursor.split(/[\\/]/).at(-1)!=='node_modules') cursor=dirname(cursor)
    if (cursor.split(/[\\/]/).at(-1)!=='node_modules') throw new Error(`Cannot locate node_modules for ${name}`)
    const relative=name.split('/')
    packagePaths.set(name,join(cursor,...relative))
  }
  for (const [name,target] of packagePaths) {
    const link=join(destination,'node_modules',...name.split('/'))
    await mkdir(dirname(link),{recursive:true}); await rm(link,{recursive:true,force:true})
    await symlink(target,link,'dir')
  }
  const bin = join(destination,'bin','roo'); await chmod(bin,0o755)
  const probeHome = resolve(stateDir, 'version-probe')
  await mkdir(probeHome, { recursive: true, mode: 0o700 })
  const result = await execFile(bin, ['--version'], { timeout: 15000, cwd: probeHome, env: { PATH: process.env.PATH, HOME: probeHome, BROWSER: '/usr/bin/true' } })
  if (!new RegExp(`(?:^|\\s)${version.replaceAll('.', '\\.')}(?:\\s|$)`).test(result.stdout.trim())) throw new Error(`Downloaded Roo reports unexpected version: ${result.stdout.trim()}`)
  console.log(`Installed pinned Roo CLI v${version} at ${bin}`)
} finally { await rm(temp,{recursive:true,force:true}) }

function validateArchive(gzipBytes) {
  const tar = gunzipSync(gzipBytes, { maxOutputLength: 256 * 1024 * 1024 })
  for (let offset=0; offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512)
    if (header.every(byte=>byte===0)) break
    const field=(start,end)=>header.toString('utf8',start,end).split('\0',1)[0]
    const name=field(0,100), prefix=field(345,500), path=prefix?`${prefix}/${name}`:name
    const type=String.fromCharCode(header[156]||48)
    if (path.startsWith('/') || path.split(/[\\/]/).includes('..') || posix.normalize(path).replace(/\/$/,'')!==path.replace(/\/$/,'')) throw new Error(`Unsafe Roo archive path ${path}`)
    if (!path.startsWith('roo-cli-darwin-arm64/')) throw new Error(`Unexpected Roo archive root ${path}`)
    if (!['0','\0','5'].includes(type)) throw new Error(`Unsupported Roo archive entry type ${type} at ${path}; refusing links and extended headers`)
    const sizeText=field(124,136).trim()
    const size=parseInt(sizeText.replace(/\s/g,''),8)||0
    if (!Number.isSafeInteger(size)||size<0) throw new Error(`Invalid Roo archive entry size at ${path}`)
    offset+=512+Math.ceil(size/512)*512
  }
}
