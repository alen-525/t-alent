import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const version = '1.48.0'
const darwinArm64ArchiveSha256 = 'a0568e64ab21d0defd2c8dfd9e236b876b6357fb752c8e451f4bfe706aeb40c0'
const argumentsList = process.argv.slice(2)
let stateDir = process.env.TALENT_STATE_DIR
for (let index = 0; index < argumentsList.length; index += 1) {
  if (argumentsList[index] === '--state-dir') stateDir = argumentsList[++index]
  else throw new Error(`Unknown setup option: ${argumentsList[index]}`)
}
if (!stateDir) throw new Error('Pass --state-dir <stateDir> or set TALENT_STATE_DIR so the binary is installed in the path used by the host.')
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`This setup script currently pins only Goose v${version} for macOS ARM64. On this platform, download the matching official release asset and set GOOSE_BIN to its path; the runtime still checks --version.`)
}

const destination = resolve(stateDir, 'goose-runtime', 'goose')
const temp = await mkdtemp(join(tmpdir(), 'talent-goose-runtime-'))
const archive = join(temp, 'goose.tar.bz2')
const extracted = join(temp, 'extract')
const assetUrl = `https://github.com/aaif-goose/goose/releases/download/v${version}/goose-aarch64-apple-darwin.tar.bz2`
try {
  const response = await fetch(assetUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Goose release download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== darwinArm64ArchiveSha256) throw new Error(`Goose release archive SHA-256 mismatch: ${digest}`)
  await writeFile(archive, bytes, { mode: 0o600 })
  await mkdir(extracted, { recursive: true })
  await execFile('tar', ['-xjf', archive, '-C', extracted], { timeout: 60_000 })
  const extractedBinary = join(extracted, 'goose')
  const output = await execFile(extractedBinary, ['--version'], { timeout: 10_000 })
  if (!(output.stdout ?? '').trim().split(/\s+/).includes(version)) throw new Error(`Downloaded Goose binary did not report version ${version}`)
  await mkdir(dirname(destination), { recursive: true })
  const staged = `${destination}.${process.pid}.tmp`
  await copyFile(extractedBinary, staged)
  await chmod(staged, 0o755)
  await rename(staged, destination)
  console.log(`Installed official Goose v${version} for macOS ARM64 at ${destination}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
