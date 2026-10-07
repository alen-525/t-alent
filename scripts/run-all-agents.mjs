import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { agentIds } from './agent-package-sources.mjs'

const [mode, ...args] = process.argv.slice(2)
if (!['cli', 'host', 'test'].includes(mode)) throw new Error('Usage: run-all-agents.mjs <cli|host|test> [options]')
const root = fileURLToPath(new URL('../', import.meta.url))
let commandArgs
if (mode === 'test') {
  const files = await Promise.all(agentIds().map(async id => {
    const dir = path.join(root, 'packages/runtime/adapters', id, 'tests')
    const names = (await readdir(dir)).filter(name => name.endsWith('.test.mjs')).sort()
    if (!names.length) throw new Error(`Registered adapter ${id} has no tests`)
    return names.map(name => path.join(dir, name))
  }))
  commandArgs = ['--test', ...args, ...files.flat()]
} else {
  const entry = path.join(root, mode === 'cli' ? 'apps/cli/index.mjs' : 'packages/runtime/cli.mjs')
  commandArgs = [entry, ...agentIds().flatMap(id => ['--package', path.join(root, 'packs', id)]), ...args]
}
const child = spawn(process.execPath, commandArgs, { stdio: 'inherit', shell: false })
const forward = signal => { child.kill(signal) }
const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM')
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('close', (code, signal) => {
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
})
