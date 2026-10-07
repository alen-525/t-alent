import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { clearMemoryCache, compileAgentPackage, renderProgram } from '../packages/runtime/agent-compiler.mjs'
import { agentIds } from './agent-package-sources.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'talent-compile-bench-'))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const measure = async action => { const start = performance.now(); const result = await action(); return { ms: performance.now() - start, result } }
try {
  const rows = []
  for (const id of agentIds()) {
    const packagePath = path.join(root, 'packs', id)
    const cold = [], memory = [], disk = []
    const compiled = await compileAgentPackage(packagePath, { cacheDir })
    for (let i = 0; i < 15; i++) {
      cold.push((await measure(() => compileAgentPackage(packagePath, { cache: false }))).ms)
      memory.push((await measure(() => compileAgentPackage(packagePath, { cacheDir }))).ms)
      clearMemoryCache()
      const sample = await measure(() => compileAgentPackage(packagePath, { cacheDir }))
      if (sample.result.cache.status !== 'disk') throw new Error(`Expected disk cache hit for ${id}`)
      disk.push(sample.ms)
    }
    const context = { input: 'Inspect the repository and fix the failing test.', workspace: '/workspace', model: { id: 'benchmark', provider: 'mock', model: 'mock', protocol: compiled.manifest.modelProtocols[0] } }
    const renderStart = performance.now()
    for (let i = 0; i < 5000; i++) renderProgram(compiled.program, context)
    rows.push({ id, compileMs: +median(cold).toFixed(3), memoryLoadMs: +median(memory).toFixed(3), diskLoadMs: +median(disk).toFixed(3), renderUs: +((performance.now() - renderStart) * 1000 / 5000).toFixed(3) })
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ samples: 15, renders: 5000, scope: 'Source validation, compilation/cache loading, and prompt rendering only; excludes native startup, inference, and tools.', rows }, null, 2))
  else { console.table(rows); console.log('ms: source validation + compilation/cache load. µs: one task prompt render. Native runtime startup, inference, and tools are excluded. Cache hits still validate source contents. Small recipes may cost less to compile than to read a disk cache.') }
} finally { clearMemoryCache(); await rm(cacheDir, { recursive: true, force: true }) }
