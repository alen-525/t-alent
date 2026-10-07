import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const directory = await mkdtemp(resolve(tmpdir(), 'talent-gemini-smoke-'))
await writeFile(resolve(directory, 'fixture.txt'), 'GEMINI_TOOL_PROOF_734')
const requests = []
let mode = 'tool', toolSent = false, socket
const server = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c
  const body = raw ? JSON.parse(raw) : {}
  requests.push({ url: req.url, headers: req.headers, body })
  if (req.url.includes('countTokens')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ totalTokens: 40 })); return }
  if (!req.url.includes('generateContent') && !req.url.includes('streamGenerateContent')) { res.writeHead(404); res.end('{}'); return }
  if (mode === 'stall') { socket = res; return }
  if (mode === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 401, message: 'mock authentication refused', status: 'UNAUTHENTICATED' } })); return }
  let parts
  if (mode === 'tool' && !toolSent) {
    toolSent = true
    const declarations = body.tools?.flatMap(t => t.functionDeclarations ?? []) ?? []
    assert(declarations.some(t => t.name === 'read_file'), 'Original Harness must send its read_file definition')
    parts = [{ functionCall: { name: 'read_file', args: { file_path: resolve(directory, 'fixture.txt') } } }]
  } else parts = [{ text: mode === 'follow' ? 'GEMINI_FOLLOWUP_OK' : 'GEMINI_TOOL_OK' }]
  const response = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 }, modelVersion: 'gemini-smoke-model', responseId: `mock-${requests.length}` }
  if (req.url.includes('streamGenerateContent')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(response)}\n\n`) }
  else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)) }
})
await new Promise((r,j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
const model = { id: 'gemini-mock', provider: 'google', model: 'gemini-smoke-model', protocol: 'google-generative-ai', apiKeyEnv: 'TALENT_MOCK_KEY', baseUrl: `http://127.0.0.1:${server.address().port}` }
const options = { workspace: directory, stateDir: resolve(directory, 'state'), env: { TALENT_MOCK_KEY: 'gemini-mock-secret', GEMINI_API_KEY: 'wrong-ambient-key' }, config: { cancelGraceMs: 300, maxSessionTurns: 8 } }
let agent
const collect = async task => { const events=[]; for await (const e of agent.executeTask(task)) events.push(e); return events }
const task = (taskId, input) => ({ taskId, input, sessionId: 'conversation', model })
const timeout = setTimeout(() => { console.error('Gemini smoke timed out'); void agent?.dispose(); socket?.destroy() }, 60000)
try {
  agent = await createAgentPackage(options)
  let events = await collect(task('first', 'Read fixture.txt with read_file, then respond.'))
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert(events.some(e => e.type === 'tool-result' && e.name === 'read_file' && e.status === 'success'), `Original read_file must execute: ${JSON.stringify(events)}`)
  assert(requests.some(r => JSON.stringify(r.body.contents).includes('GEMINI_TOOL_PROOF_734')), 'Tool result must be sent back to model')
  const session = events.find(e => e.type === 'session').sessionId
  await agent.dispose(); agent = await createAgentPackage(options)
  mode = 'follow'
  const beforeFollow = requests.length
  events = await collect(task('follow', 'Continue and remember the previous answer.'))
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert.equal(events.find(e => e.type === 'session').sessionId, session)
  assert(requests.slice(beforeFollow).some(r => JSON.stringify(r.body.contents).includes('GEMINI_TOOL_OK')), 'Native persisted history must resume across instances')
  mode = 'stall'
  const running = collect(task('cancel', 'Wait for a delayed response.'))
  const start = Date.now()
  while (!socket) { if (Date.now()-start>15000) throw new Error('No pending model request for cancellation'); await new Promise(r => setTimeout(r, 20)) }
  await agent.cancelTask('cancel')
  assert((await running).some(e => e.type === 'cancelled'))
  socket.destroy(); mode = 'follow'
  assert.equal((await collect(task('recover', 'Continue after cancellation.'))).at(-1)?.type, 'assistant-complete')
  mode = 'error'
  events = await collect(task('error', 'Fail this request.'))
  assert(events.some(e => e.type === 'error')); assert(!events.some(e => e.type === 'assistant-complete'))
  const generation = requests.filter(r => /[Gg]enerateContent/.test(r.url))
  assert(generation.length > 0)
  assert(generation.every(r => r.url.includes('/models/gemini-smoke-model:')), 'The selected primary model must be honored')
  assert(generation.every(r => r.headers['x-goog-api-key'] === 'gemini-mock-secret' || r.headers.authorization === 'Bearer gemini-mock-secret'), 'External profile key must be used')
  const readTree = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path=resolve(dir,entry.name); if(entry.isDirectory()) await readTree(path); else assert(!(await readFile(path)).includes(Buffer.from('gemini-mock-secret')), `Credential persisted: ${entry.name}`) } }
  await readTree(resolve(directory, 'state'))
  console.log('Gemini 0.62.0 original Harness smoke passed: profile route/key, read_file/tool return, persisted history, cancel/recover, provider failure, no credential artifacts.')
} finally {
  clearTimeout(timeout); await agent?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true })
}
