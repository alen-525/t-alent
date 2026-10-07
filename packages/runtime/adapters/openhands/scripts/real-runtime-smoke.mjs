import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(tmpdir(), 'talent-openhands-smoke-'))
const workspace = join(temp, 'workspace'), stateDir = join(temp, 'state')
await mkdir(workspace); await writeFile(join(workspace, 'probe.txt'), 'OPENHANDS_NATIVE_TOOL_PROOF_718')
let mode = 'tool', toolSent = false, pending
const requests = []
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end()
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw); requests.push(body)
  assert.equal(req.headers.authorization, 'Bearer openhands-local-smoke-key')
  assert(body.model.includes('openhands-smoke-model') || body.model.includes('openhands-other-model'), body.model)
  if (mode === 'stall') { pending = res; return }
  if (mode === 'unauthorized') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Mock provider rejected credential', type: 'authentication_error', code: 'invalid_api_key' } })); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (mode === 'tool' && !toolSent) {
    toolSent = true
    const tool = (body.tools ?? []).find(item => /terminal/i.test(item.function?.name ?? ''))
    assert(tool, `OpenHands native terminal tool missing: ${JSON.stringify(body.tools)}`)
    res.end(JSON.stringify({ id: 'chatcmpl-openhands', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'openhands-terminal-1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ command: 'cat probe.txt', timeout: 20 }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  } else {
    const text = mode === 'follow' ? 'OPENHANDS_HISTORY_OK' : mode === 'route' ? 'OPENHANDS_ROUTE_OK' : 'OpenHands local mock response.'
    res.end(JSON.stringify({ id: 'chatcmpl-openhands', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  }
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const profile = model => ({ id: 'openhands-smoke', provider: 'local-openai', model, protocol: 'openai-chat-completions', apiKeyEnv: 'OPENHANDS_SMOKE_KEY', baseUrl })
const python = process.env.OPENHANDS_PYTHON ?? resolve(process.cwd(), '../../../../.talent/openhands/venv/bin/python')
let agent
const collect = async (input, taskId, model = profile('openhands-smoke-model'), signal) => { const events = []; for await (const event of agent.executeTask({ taskId, input, sessionId: 'sdk-smoke-conversation', model }, { signal })) events.push(event); return events }
try {
  agent = await createAgentPackage({ workspace, stateDir, env: { OPENHANDS_SMOKE_KEY: 'openhands-local-smoke-key' }, config: { python, cancelGraceMs: 2500 } })
  let events = await collect('Read probe.txt with the terminal tool and report its contents.', 'tool')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))
  assert(events.some(event => event.type === 'tool-call' && event.name === 'terminal'), JSON.stringify(events))
  assert(events.some(event => event.type === 'tool-result' && JSON.stringify(event).includes('OPENHANDS_NATIVE_TOOL_PROOF_718')), JSON.stringify(events))
  assert(requests.some(body => JSON.stringify(body.messages).includes('OPENHANDS_NATIVE_TOOL_PROOF_718')), 'tool output must be sent back in the next SDK model turn')
  const conversationId = events.find(event => event.type === 'session')?.sessionId
  assert(conversationId)

  await agent.dispose()
  agent = await createAgentPackage({ workspace, stateDir, env: { OPENHANDS_SMOKE_KEY: 'openhands-local-smoke-key' }, config: { python, cancelGraceMs: 2500 } })
  mode = 'follow'; events = await collect('Continue from the saved conversation.', 'history')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))
  assert.equal(events.find(event => event.type === 'session')?.sessionId, conversationId)
  assert(JSON.stringify(requests.at(-1).messages).includes('OPENHANDS_NATIVE_TOOL_PROOF_718'), 'resumed SDK history must include the prior native tool observation')

  mode = 'route'; const routeStart = requests.length
  events = await collect('This model route has independent history.', 'route', profile('openhands-other-model'))
  assert.equal(events.at(-1)?.type, 'assistant-complete')
  assert(!requests.slice(routeStart).some(body => JSON.stringify(body.messages).includes('OPENHANDS_NATIVE_TOOL_PROOF_718')), 'changed model routes must start fresh history')

  mode = 'stall'; const controller = new AbortController()
  const pendingTask = collect('Wait for the delayed model response.', 'cancel', profile('openhands-smoke-model'), controller.signal)
  const started = Date.now(); while (!pending) { if (Date.now() - started > 20000) throw new Error('OpenHands did not reach the local cancellation request'); await new Promise(resolveWait => setTimeout(resolveWait, 20)) }
  await agent.cancelTask('cancel'); events = await pendingTask
  assert.equal(events.at(-1)?.type, 'cancelled')
  pending?.destroy(); pending = null

  mode = 'follow'; events = await collect('Continue after cancellation.', 'after-cancel')
  assert.equal(events.at(-1)?.type, 'assistant-complete', JSON.stringify(events.slice(-5)))

  mode = 'unauthorized'; events = await collect('Fail this authentication request.', 'unauthorized', profile('openhands-smoke-model'))
  assert(events.some(event => event.type === 'error'), JSON.stringify(events.slice(-5)))
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(JSON.stringify(events).includes('openhands-local-smoke-key'), false)

  const scan = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await scan(path); else assert.equal((await readFile(path)).includes(Buffer.from('openhands-local-smoke-key')), false, `credential leaked to ${path}`) } }
  await scan(stateDir)
  console.log('OpenHands SDK 1.51.0 smoke passed: native terminal execution and observation return, persisted/resumed history, model-route isolation, SDK cancellation/recovery, 401 failure, and credential scan.')
} finally {
  await agent?.dispose(); pending?.destroy(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); await rm(temp, { recursive: true, force: true })
}
