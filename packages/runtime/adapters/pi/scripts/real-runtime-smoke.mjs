import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const secret = 'pi-smoke-secret-never-persist'
const root = await mkdtemp(join(tmpdir(), 'pi-real-sdk-smoke-'))
const workspace = join(root, 'workspace'), stateDir = join(root, 'state')
await mkdir(workspace); await writeFile(join(workspace, 'fixture.txt'), 'PI_NATIVE_TOOL_PROOF_248')
const requests = []; let mode = 'tool', toolSent = false, pending
const server = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c
  const body = JSON.parse(raw); requests.push({ path: req.url, authorization: req.headers.authorization, body })
  assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${secret}`)
  if (mode === 'stall') { pending = res; return }
  if (mode === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Mock credential rejected' } })); return }
  let delta, finish
  if (mode === 'tool' && !toolSent) {
    toolSent = true
    const read = body.tools?.find(t => t.function?.name === 'read')
    assert(read, 'Pi must expose its original read tool')
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'pi-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(workspace, 'fixture.txt') }) } }] }; finish = 'tool_calls'
  } else { delta = { role: 'assistant', content: mode === 'follow' ? 'PI_FOLLOW_OK' : 'PI_TOOL_OK' }; finish = 'stop' }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = { id: 'pi-mock', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r) })
const model = { id: 'pi-smoke', provider: 'custom-provider', model: 'pi-mock-model', protocol: 'openai-chat-completions', apiKeyEnv: 'PI_SMOKE_KEY', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
const options = { workspace, stateDir, env: { PI_SMOKE_KEY: secret } }
let agent
const collect = async (input, taskId = 'first', sessionId = 'conversation', profile = model) => { const events = []; for await (const e of agent.executeTask({ taskId, sessionId, input, model: profile })) events.push(e); return events }
const timer = setTimeout(() => { console.error('Pi smoke timed out'); void agent?.dispose(); pending?.destroy() }, 60000)
try {
  agent = await createAgentPackage(options)
  let events = await collect('Read fixture.txt with your original read tool.')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert(events.some(e => e.type === 'tool-call')); assert(events.some(e => e.type === 'tool-result' && e.output.includes('PI_NATIVE_TOOL_PROOF_248')))
  assert(requests.some(r => JSON.stringify(r.body.messages).includes('PI_NATIVE_TOOL_PROOF_248')))
  const session = events.find(e => e.type === 'session').sessionId
  await agent.dispose(); agent = await createAgentPackage(options); mode = 'follow'
  const before = requests.length; events = await collect('Continue the prior conversation.', 'follow')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events))
  assert.equal(events.find(e => e.type === 'session').sessionId, session)
  assert(requests.slice(before).some(r => JSON.stringify(r.body.messages).includes('PI_TOOL_OK')))
  const isolated = requests.length
  await collect('New model route.', 'isolated', 'conversation', { ...model, model: 'pi-other-model' })
  assert(!requests.slice(isolated).some(r => JSON.stringify(r.body.messages).includes('PI_TOOL_OK')))
  mode = 'stall'; const running = collect('Wait for API.', 'cancel'); const start = Date.now()
  while (!pending) { if (Date.now() - start > 15000) throw new Error('Pi never reached cancellation request'); await new Promise(r => setTimeout(r, 20)) }
  await agent.cancelTask('cancel'); assert.equal((await running).at(-1)?.type, 'cancelled'); pending.destroy()
  mode = 'follow'; assert.equal((await collect('Continue after cancellation.', 'recover')).at(-1)?.type, 'assistant-complete')
  mode = 'error'; events = await collect('Reject this request.', 'error')
  assert(events.some(e => e.type === 'error'), JSON.stringify(events)); assert(!events.some(e => e.type === 'assistant-complete'))
  assert(requests.every(r => ['pi-mock-model', 'pi-other-model'].includes(r.body.model)))
  const scan = async dir => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await scan(p); else assert(!(await readFile(p)).includes(Buffer.from(secret)), `Credential in ${e.name}`) } }
  await scan(stateDir)
  console.log('Pi 0.73.1 original SDK smoke passed: exact profile/key, original read tool/return, native cross-instance session, model isolation, cancellation/recovery, provider failure, in-memory authentication.')
} finally { clearTimeout(timer); await agent?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }) }
