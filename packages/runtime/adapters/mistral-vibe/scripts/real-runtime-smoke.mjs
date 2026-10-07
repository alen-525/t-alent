import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-mistral-vibe-smoke-'))
const workspace = join(temp, 'workspace'), stateDir = join(temp, 'state')
await mkdir(workspace); await writeFile(join(workspace, 'proof.txt'), 'MISTRAL_VIBE_NATIVE_SHELL_PROOF_804')
await mkdir(join(workspace, '.vibe'))
await writeFile(join(workspace, '.vibe/config.toml'), 'active_model = "unselected-workspace-model"\nenable_telemetry = true\n')
let mode = 'tool', toolSent = false, pending
const requests = []
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end()
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw); requests.push(body)
  assert.equal(req.headers.authorization, 'Bearer mistral-vibe-local-smoke-key')
  assert(/^mistral-vibe-(?:smoke|other)-model$/.test(body.model), body.model)
  if (mode === 'stall') { pending = res; req.on('close', () => { pending = null }); return }
  if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'mock invalid key', type: 'authentication_error', code: 'invalid_api_key' } })); return }
  const content = mode === 'follow' ? 'MISTRAL_VIBE_HISTORY_OK' : mode === 'route' ? 'MISTRAL_VIBE_ROUTE_OK' : 'Local Mistral Vibe mock response.'
  const tool = (body.tools ?? []).find(item => /bash|shell/i.test(item.function?.name ?? ''))
  assert(!(body.tools ?? []).some(item => /browser|desktop|computer_use/i.test(item.function?.name ?? '')), 'browser and desktop tools must not be exposed')
  if (mode === 'tool' && !toolSent) {
    assert(tool, `Mistral Vibe native bash tool missing: ${JSON.stringify(body.tools)}`)
    toolSent = true
    reply(req, res, body, { role: 'assistant', content: null, tool_calls: [{ id: 'mistral-vibe-bash-1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ command: 'cat proof.txt' }) } }] }, 'tool_calls')
  } else reply(req, res, body, { role: 'assistant', content }, 'stop')
})
function reply(req, res, body, message, finishReason) {
  const payload = { id: 'chatcmpl-vibe', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const delta = { ...message }; delete delta.role
    if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }))
    res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: payload.id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
}
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const profile = model => ({ id: 'vibe-smoke', provider: 'local-openai-compatible', model, protocol: 'openai-chat-completions', apiKeyEnv: 'MISTRAL_VIBE_SMOKE_KEY', baseUrl })
const python = process.env.MISTRAL_VIBE_PYTHON ?? fileURLToPath(new URL('../../../../../.talent/mistral-vibe/mistral-vibe-runtime/venv/bin/python', import.meta.url))
let agent
const collect = async (input, taskId, model = profile('mistral-vibe-smoke-model'), signal) => { const events = []; for await (const event of agent.executeTask({ taskId, input, sessionId: 'vibe-smoke-conversation', model }, { signal })) events.push(event); return events }
try {
  agent = await createAgentPackage({ workspace, stateDir, env: { MISTRAL_VIBE_SMOKE_KEY: 'mistral-vibe-local-smoke-key' }, config: { python, cancelGraceMs: 3000 } })
  let events = await collect('Read proof.txt using the terminal and report its exact contents.', 'tool')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))
  assert(events.some(event => event.type === 'tool-call' && /bash|shell/i.test(event.name)), JSON.stringify(events))
  assert(events.some(event => event.type === 'tool-result' && JSON.stringify(event).includes('MISTRAL_VIBE_NATIVE_SHELL_PROOF_804')), JSON.stringify(events))
  assert(requests.some(body => JSON.stringify(body.messages).includes('MISTRAL_VIBE_NATIVE_SHELL_PROOF_804')), 'native shell observation must be sent back to the model')
  const sessionId = events.find(event => event.type === 'session')?.sessionId
  assert(sessionId)

  await agent.dispose()
  agent = await createAgentPackage({ workspace, stateDir, env: { MISTRAL_VIBE_SMOKE_KEY: 'mistral-vibe-local-smoke-key' }, config: { python, cancelGraceMs: 3000 } })
  mode = 'follow'; events = await collect('Continue from the existing session.', 'history')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))
  assert.equal(events.find(event => event.type === 'session')?.sessionId, sessionId)
  assert(JSON.stringify(requests.at(-1).messages).includes('MISTRAL_VIBE_NATIVE_SHELL_PROOF_804'), 'resumed session must include the prior native shell observation')

  mode = 'route'; const routeStart = requests.length
  events = await collect('This model route should not see prior history.', 'route', profile('mistral-vibe-other-model'))
  assert.equal(events.at(-1)?.type, 'assistant-complete')
  assert(!requests.slice(routeStart).some(body => JSON.stringify(body.messages).includes('MISTRAL_VIBE_NATIVE_SHELL_PROOF_804')), 'different model routes must start separate sessions')

  mode = 'stall'; const controller = new AbortController()
  const pendingTask = collect('Wait for the model response.', 'cancel', profile('mistral-vibe-smoke-model'), controller.signal)
  const started = Date.now(); while (!pending) { if (Date.now() - started > 40_000) throw new Error('Vibe did not reach the local cancellation request'); await new Promise(resolveWait => setTimeout(resolveWait, 25)) }
  await agent.cancelTask('cancel'); events = await pendingTask
  assert.equal(events.at(-1)?.type, 'cancelled')

  mode = 'follow'; events = await collect('Continue after cancelling the previous task.', 'after-cancel')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))

  mode = 'unauthorized'; events = await collect('Fail this authentication request.', 'unauthorized')
  assert.equal(events.at(-1)?.type, 'error', JSON.stringify(events.slice(-5)))
  assert.equal(JSON.stringify(events).includes('mistral-vibe-local-smoke-key'), false)
  const scan = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await scan(path); else assert.equal((await readFile(path)).includes(Buffer.from('mistral-vibe-local-smoke-key')), false, `credential leaked to ${path}`) } }
  await scan(stateDir)
  console.log('Mistral Vibe 2.25.8 smoke passed: native shell call and model observation, ACP session resume/history, model-route isolation, native cancellation/recovery, 401 failure, and credential scan.')
} finally {
  await agent?.dispose(); pending?.destroy(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); await rm(temp, { recursive: true, force: true })
}
