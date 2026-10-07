import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createAgentPackage, createAgentPackageWithRuntime } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-opencode-smoke-'))
const workspace = join(temp, 'workspace')
const stateDir = join(temp, 'state')
await mkdir(workspace)
await writeFile(join(workspace, 'probe.txt'), 'OPENCODE_TOOL_PROOF_924')
const requests = new Map(), records = []
let mode = 'hello', toolSent = false, pending
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const payload = JSON.parse(body)
  const protocol = req.url.endsWith('/chat/completions') ? 'openai-chat-completions' : req.url.endsWith('/responses') ? 'openai-responses' : req.url.endsWith('/messages') ? 'anthropic' : null
  if (process.env.OPENCODE_SMOKE_DEBUG) console.error('mock request', req.url, payload.stream)
  assert.ok(protocol, `unexpected mock route ${req.url}`)
  assert.equal(protocol === 'anthropic' ? req.headers['x-api-key'] : req.headers.authorization, protocol === 'anthropic' ? 'local-smoke-secret' : 'Bearer local-smoke-secret')
  assert(['smoke-model', 'other-model'].includes(payload.model))
  records.push({ protocol, payload })
  if (mode === 'stall') { pending = res; return }
  if (mode === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Mock provider rejected credential' } })); return }
  requests.set(protocol, (requests.get(protocol) ?? 0) + 1)
  const text = mode === 'follow' ? 'OPENCODE_FOLLOW_OK' : mode === 'tool' ? 'OPENCODE_TOOL_OK' : `OpenCode ${protocol} reached the local mock endpoint.`
  if (protocol === 'openai-chat-completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    let delta = { content: text }, finish = 'stop'
    if (mode === 'tool' && !toolSent && payload.tools?.length) {
      toolSent = true
      const read = payload.tools?.find(t => t.function?.name === 'read'); assert(read, `Original OpenCode read tool required: ${JSON.stringify(payload.tools)}`)
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'opencode-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: join(workspace, 'probe.txt') }) } }] }; finish = 'tool_calls'
    }
    const data = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...data, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  if (protocol === 'openai-responses') {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
    const response = { id: 'resp-smoke', object: 'response', status: 'in_progress', output: [], usage: null }
    const message = { id: 'msg-smoke', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    const emit = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
    emit('response.created', { response })
    emit('response.in_progress', { response })
    emit('response.output_item.added', { output_index: 0, item: message })
    emit('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
    emit('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: text })
    emit('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text })
    emit('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text } })
    emit('response.output_item.done', { output_index: 0, item: { ...message, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } })
    emit('response.completed', { response: { ...response, status: 'completed', output: [{ ...message, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: 'msg-smoke', type: 'message', role: 'assistant', model: 'smoke-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  send('message_stop', { type: 'message_stop' })
  res.end()
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
const baseProfile = { id: 'local-smoke', name: 'Local mock', provider: 'mock', model: 'smoke-model', apiKeyEnv: 'OPENCODE_SMOKE_KEY', baseUrl: `http://127.0.0.1:${port}/v1` }
let agent
const controller = new AbortController()
const smokeTimeout = setTimeout(() => controller.abort(), 20000)
try {
  if (process.env.OPENCODE_BIN) {
    const { spawn } = await import('node:child_process')
    agent = await createAgentPackageWithRuntime({ workspace, stateDir, env: { OPENCODE_SMOKE_KEY: 'local-smoke-secret' }, config: { cancelGraceMs: 500 } }, { command: resolve(process.env.OPENCODE_BIN), spawnProcess: spawn })
  } else {
    agent = await createAgentPackage({ workspace, stateDir, env: { OPENCODE_SMOKE_KEY: 'local-smoke-secret' }, config: { cancelGraceMs: 500 } })
  }
  for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic']) {
    const events = []
    for await (const event of agent.executeTask({ taskId: `smoke-${protocol}`, input: 'Reply with a short greeting.', sessionId: `smoke-${protocol}`, model: { ...baseProfile, protocol } }, { signal: controller.signal })) events.push(event)
    if (events.some(event => event.type === 'error')) throw new Error(`OpenCode ${protocol} smoke failed (${JSON.stringify(Object.fromEntries(requests))}): ${JSON.stringify(events)}`)
    assert.ok((requests.get(protocol) ?? 0) >= 1, `OpenCode must send a ${protocol} request to the local mock`)
    assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
    assert.match(events.find(event => event.type === 'assistant-replace')?.text ?? '', new RegExp(`${protocol} reached the local mock endpoint`))
    assert.equal(JSON.stringify(events).includes('local-smoke-secret'), false)
  }
  const profile = { ...baseProfile, protocol: 'openai-chat-completions' }
  const collect = async (input, taskId, model = profile) => { const events = []; for await (const e of agent.executeTask({ taskId, input, sessionId: 'tool-conversation', model }, { signal: controller.signal })) events.push(e); return events }
  mode = 'tool'
  let events = await collect('Read probe.txt using the native read tool.', 'tool')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert(events.some(e => e.type === 'tool-call')); assert(events.some(e => e.type === 'tool-result'), JSON.stringify(events))
  assert(records.some(r => JSON.stringify(r.payload.messages ?? []).includes('OPENCODE_TOOL_PROOF_924')))
  const session = events.find(e => e.type === 'session').sessionId
  await agent.dispose()
  agent = await createAgentPackage({ workspace, stateDir, env: { OPENCODE_SMOKE_KEY: 'local-smoke-secret' }, config: { cancelGraceMs: 500 } })
  mode = 'follow'; const before = records.length
  events = await collect('Continue the previous conversation.', 'follow')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert.equal(events.find(e => e.type === 'session').sessionId, session)
  assert(records.slice(before).some(r => JSON.stringify(r.payload.messages ?? []).includes('OPENCODE_TOOL_OK')))
  const isolated = records.length
  await collect('Use a fresh model route.', 'isolated', { ...profile, model: 'other-model' })
  assert(!records.slice(isolated).some(r => JSON.stringify(r.payload.messages ?? []).includes('OPENCODE_TOOL_OK')))
  mode = 'stall'; const running = collect('Wait for the delayed API.', 'cancel'); const start = Date.now()
  while (!pending) { if (Date.now() - start > 15000) throw new Error('OpenCode did not reach cancellation request'); await new Promise(r => setTimeout(r, 20)) }
  await agent.cancelTask('cancel'); assert.equal((await running).at(-1)?.type, 'cancelled'); pending.destroy()
  mode = 'follow'; assert.equal((await collect('Continue after cancellation.', 'recover')).at(-1)?.type, 'assistant-complete')
  mode = 'error'; events = await collect('Fail this API request.', 'error')
  assert(events.some(e => e.type === 'error'), JSON.stringify(events)); assert(!events.some(e => e.type === 'assistant-complete'))
  const scan = async dir => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await scan(p); else assert(!(await readFile(p)).includes(Buffer.from('local-smoke-secret')), `Credential in ${e.name}`) } }
  await scan(stateDir)
  console.log('OpenCode 1.18.32 runtime smoke passed: three protocol routes, exact key/model, original read tool/return, native cross-instance history, model isolation, cancellation/recovery, provider failure.')
} finally {
  clearTimeout(smokeTimeout)
  await agent?.dispose()
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(temp, { recursive: true, force: true })
}
