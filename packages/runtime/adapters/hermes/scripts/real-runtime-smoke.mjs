import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const defaultState = resolve(process.cwd(), '../../../../.talent/hermes')
const python = process.env.TALENT_HERMES_PYTHON || process.env.TALENT_PYTHON || resolve(defaultState, 'hermes-runtime/venv/bin/python')
const stateDir = process.env.TALENT_HERMES_STATE_DIR || defaultState
const secret = 'hermes-smoke-secret-never-persist'
const requests = []
let mode = 'tool'
let delayedResolve
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (!/\/(?:chat\/completions|responses)(?:\?|$)/.test(req.url ?? '')) {
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not a model chat route' } })); return
  }
  if (!body) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'host-model-with-slash', object: 'model' }] })); return
  }
  const request = JSON.parse(body)
  requests.push(request)
  if (mode === 'unauthorized') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid credentials' } }))
    return
  }
  if (mode === 'delay') {
    delayedResolve?.()
    return
  }
  let response
  if (mode === 'tool') {
    assert(request.tools?.some(entry => entry.function?.name === 'write_file'), 'Hermes native file tool must be available')
    mode = 'read'
    response = { id: 'chatcmpl-smoke-write', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_smoke_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(workspace, 'hermes-smoke.txt'), content: 'native tool observed' }) } }] }, finish_reason: null }] }
  } else if (mode === 'read') {
    assert(request.tools?.some(entry => entry.function?.name === 'read_file'), 'Hermes native file observation tool must be available')
    mode = 'final'
    response = { id: 'chatcmpl-smoke-read', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_smoke_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: join(workspace, 'hermes-smoke.txt') }) } }] }, finish_reason: null }] }
  } else {
    response = { id: 'chatcmpl-smoke-final', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `I ran the native coding tool and inspected its output. Echo check: ${secret}` }, finish_reason: null }] }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(`data: ${JSON.stringify(response)}\n\n`)
  const finish = { id: response.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: response.choices[0].delta.tool_calls ? 'tool_calls' : 'stop' }] }
  res.write(`data: ${JSON.stringify(finish)}\n\n`)
  res.end('data: [DONE]\n\n')
})

function listen() { return new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)) }) }
function waitForRequest(count, timeoutMs = 10_000) { return new Promise((resolveWait, reject) => { if (requests.length >= count) return resolveWait(); const timer = setTimeout(() => reject(new Error('timed out waiting for Hermes model request')), timeoutMs); const poll = setInterval(() => { if (requests.length >= count) { clearInterval(poll); clearTimeout(timer); resolveWait() } }, 20) }) }
async function collect(agent, taskId, input, model, sessionId, signal) { const events = []; for await (const event of agent.executeTask({ taskId, input, model, sessionId }, { signal })) events.push(event); return events }
async function walk(dir) { const result = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) result.push(...await walk(path)); else if (entry.isFile()) result.push(path) } return result }
async function historySnapshot() {
  const files = await walk(resolve(stateDir, 'hermes', 'profiles'))
  const histories = files.filter(path => /\/profiles\/[^/]+\/sessions\/[^/]+\.json$/.test(path))
  return Object.fromEntries(await Promise.all(histories.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
}

const port = await listen()
const workspace = await mkdtemp(join(os.tmpdir(), 'hermes-native-smoke-'))
const profile = { id: 'smoke', name: 'Smoke Profile', provider: 'arbitrary host provider label', model: 'openai/host-model-with-slash', protocol: 'openai-chat-completions', apiKeyEnv: 'HERMES_SMOKE_KEY', baseUrl: `http://127.0.0.1:${port}/v1` }
const env = { HERMES_SMOKE_KEY: secret, HERMES_SMOKE_AMBIENT_KEY: 'ambient-sensitive-value' }
const agent = await createAgentPackage({ workspace, stateDir, env, config: { python, cancelGraceMs: 1500 } })
try {
  mode = 'tool'
  const first = await collect(agent, 'native-one', 'Create hermes-smoke.txt with “native tool observed” and report the observed content.', profile, 'native-conversation')
  assert(first.some(event => event.type === 'tool-call' && event.name === 'write_file'))
  assert(first.some(event => event.type === 'tool-result' && event.name === 'write_file'))
  assert(first.some(event => event.type === 'tool-call' && event.name === 'read_file'))
  assert(first.some(event => event.type === 'tool-result' && event.name === 'read_file' && event.output.includes('native tool observed')))
  assert.equal(first.at(-1).type, 'assistant-complete')
  assert.equal(await readFile(join(workspace, 'hermes-smoke.txt'), 'utf8'), 'native tool observed')
  assert.equal(requests[0].model, profile.model, `native request model must preserve exact host ID; got ${requests[0].model}`)
  assert(requests[1].messages.some(message => message.role === 'tool' && String(message.content).includes('hermes-smoke.txt')), 'upstream write observation should be sent to the next model request')
  assert(requests[2].messages.some(message => message.role === 'tool' && String(message.content).includes('native tool observed')), 'native file observation should be sent to the following model request')

  mode = 'final'
  const resumed = await collect(agent, 'native-two', 'Continue using the earlier observation.', profile, 'native-conversation')
  assert(resumed.some(event => event.type === 'assistant-complete'))
  assert.equal(JSON.stringify(resumed).includes(secret), false, 'worker events should redact echoed model secrets')
  assert.equal(JSON.stringify(requests.at(-1).messages).includes(secret), false, 'saved native history should redact echoed model secrets before reuse')
  assert(requests.at(-1).messages.some(message => String(message.content ?? '').includes('native tool observed')), 'native history should resume in another agent instance')
  const isolatedProfile = { ...profile, model: 'another/provider/slash-id' }
  await collect(agent, 'isolated-profile', 'Say ready.', isolatedProfile, 'native-conversation')
  const isolatedReq = requests.at(-1)
  assert.equal(isolatedReq.model, isolatedProfile.model)
  assert.equal(isolatedReq.messages.some(message => String(message.content ?? '').includes('native tool observed')), false, 'different full model route must not inherit prior history')

  const checkpointBeforeCancel = await historySnapshot()
  mode = 'delay'
  let gotRequest
  const waitRequest = new Promise(resolveWait => { gotRequest = resolveWait })
  delayedResolve = gotRequest
  const controller = new AbortController()
  const pending = collect(agent, 'cancel-native', 'Wait for the delayed model.', profile, 'native-conversation', controller.signal)
  await waitRequest
  controller.abort()
  const cancelled = await pending
  assert(cancelled.some(event => event.type === 'cancelled'), 'native call cancellation should close worker and surface cancellation')
  assert.deepEqual(await historySnapshot(), checkpointBeforeCancel, 'cancellation must preserve the last successful history checkpoint')

  mode = 'final'
  const recovered = await collect(agent, 'recovery', 'Continue from saved history.', profile, 'native-conversation')
  assert(recovered.some(event => event.type === 'assistant-complete'))
  assert(requests.at(-1).messages.some(message => String(message.content ?? '').includes('native tool observed')), 'successful native session history should survive cancellation/recovery')

  mode = 'unauthorized'
  const checkpointBefore401 = await historySnapshot()
  const unauthorized = await collect(agent, 'unauthorized', 'Try the model.', profile, 'native-conversation')
  assert(unauthorized.some(event => event.type === 'error'))
  assert.equal(JSON.stringify(unauthorized).includes(secret), false)
  assert.deepEqual(await historySnapshot(), checkpointBefore401, 'provider failure must preserve the last successful history checkpoint')
  const files = await walk(resolve(stateDir, 'hermes', 'profiles'))
  for (const file of files) assert.equal((await readFile(file)).includes(secret), false, `credential persisted in ${file}`)
  assert.equal(JSON.stringify(env).includes(secret), true)
  process.stdout.write(`Hermes native smoke passed: tool observation→next model request; history resume; exact slash-bearing model IDs; route isolation; cancel/recovery; 401 redaction; ${files.length} state files key-scanned.\n`)
} finally {
  await agent.dispose()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  await rm(workspace, { recursive: true, force: true })
}
