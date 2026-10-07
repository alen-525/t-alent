import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-qwen-smoke-'))
const workspace = join(temp, 'workspace'), stateDir = join(temp, 'state')
await mkdir(workspace); await writeFile(join(workspace, 'probe.txt'), 'QWEN_TOOL_PROOF_824')
let mode = 'hello', firstTool = true, pending
const requests = []
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end()
  let raw = ''; for await (const c of req) raw += c
  const payload = JSON.parse(raw); requests.push(payload)
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer qwen-smoke-key')
  assert.equal(payload.model, 'qwen-smoke-model')
  if (mode === 'stall') { pending = res; return }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
  const send = value => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-qwen', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: value, finish_reason: null }] })}\n\n`)
  if (mode === 'tool' && firstTool && payload.tools?.length) {
    firstTool = false
    const tool = payload.tools.find(t => /read/i.test(t.function?.name ?? ''))
    assert(tool, `Qwen native file-reading tool missing: ${JSON.stringify(payload.tools)}`)
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'qwen-read-1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ file_path: join(workspace, 'probe.txt') }) } }] })
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-qwen', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  } else {
    send({ role: 'assistant', content: mode === 'tool' ? 'QWEN_TOOL_OK' : mode === 'follow' ? 'QWEN_FOLLOW_OK' : 'Qwen reached the local mock.' })
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-qwen', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  }
  res.write('data: [DONE]\n\n'); res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const model = { id: 'qwen-local-smoke', provider: 'local', model: 'qwen-smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'QWEN_SMOKE_KEY', baseUrl }
let agent
const collect = async (text, taskId, signal) => { const events = []; for await (const e of agent.executeTask({ taskId, input: text, sessionId: 'smoke-chat', model }, { signal })) events.push(e); return events }
try {
  agent = await createAgentPackage({ workspace, stateDir, env: { QWEN_SMOKE_KEY: 'qwen-smoke-key' }, config: { cancelGraceMs: 600 } })
  let events = await collect('Say hello.', 'hello')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events))
  mode = 'tool'; events = await collect('Read probe.txt with your native read tool, then return its exact content.', 'tool')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert(events.some(e => e.type === 'tool-call'), JSON.stringify(events)); assert(events.some(e => e.type === 'tool-result'), JSON.stringify(events))
  assert(requests.some(r => JSON.stringify(r.messages).includes('QWEN_TOOL_PROOF_824')), 'native tool result must return into Qwen history')
  const session = events.find(e => e.type === 'session')?.sessionId
  await agent.dispose()
  agent = await createAgentPackage({ workspace, stateDir, env: { QWEN_SMOKE_KEY: 'qwen-smoke-key' } })
  mode = 'follow'; events = await collect('Continue our conversation.', 'follow')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert.equal(events.find(e => e.type === 'session')?.sessionId, session)
  assert(requests.at(-1).messages.some(m => JSON.stringify(m).includes('QWEN_TOOL_OK') || JSON.stringify(m).includes('QWEN_TOOL_PROOF_824')))
  mode = 'stall'
  const controller = new AbortController()
  const running = collect('Wait on the response.', 'cancel', controller.signal)
  const start = Date.now(); while (!pending) { if (Date.now() - start > 15000) throw new Error('Qwen did not reach local mock before timeout'); await new Promise(r => setTimeout(r, 20)) }
  await agent.cancelTask('cancel'); assert.equal((await running).at(-1)?.type, 'cancelled'); pending.destroy()
  const scan = async dir => { for (const item of await readdir(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory()) await scan(path); else assert.equal((await readFile(path)).includes(Buffer.from('qwen-smoke-key')), false, `credential leaked to ${path}`) } }
  await scan(stateDir)
  console.log('Qwen Code 0.24.7 local runtime smoke passed: OpenAI-compatible request, native tool return, persisted session/history, cancellation, and credential scan.')
} finally {
  await agent?.dispose(); pending?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true })
}
