import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createAgentPackage } from '../src/index.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'deepseek-original-runtime-'))
const workspace = join(temporary, 'workspace')
const stateDir = join(temporary, 'state')
await mkdir(workspace)
await writeFile(join(workspace, 'probe.txt'), 'LOCAL_READ_SENTINEL_93d26')

const requests = []
let pendingHang = null
let hangTriggered = false
let hangStartedResolve
const hangStarted = new Promise(resolve => { hangStartedResolve = resolve })
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push({ body, sessionId: request.headers['x-deepseek-harness-session-id'] })
  const latestUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user')
  const userText = JSON.stringify(latestUser?.content ?? '')

  if (userText.includes('FORCE_PROVIDER_ERROR')) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: {
      type: 'authentication_error',
      message: 'fixture provider rejection smoke-key-not-for-production',
    } }))
    return
  }
  if (userText.includes('HANG_FOR_CANCEL') && !hangTriggered && !userText.includes('RESUME_AFTER_CANCEL')) {
    hangTriggered = true
    pendingHang = response
    hangStartedResolve()
    request.once('close', () => { pendingHang = null })
    return
  }

  const previousToolResult = JSON.stringify(body.messages ?? []).includes('LOCAL_READ_SENTINEL_93d26')
  const requestsRead = userText.includes('READ_FILE')
  if (requestsRead && !previousToolResult) {
    writeSse(response, [
      { type: 'message_start', message: { id: 'msg_tool', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_read_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'probe.txt' }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    return
  }

  const answer = userText.includes('RESUME_AFTER_CANCEL')
    ? 'Recovered the prior session after cancellation.'
    : userText.includes('SECOND_TURN')
      ? 'Second task used the existing session.'
      : previousToolResult
        ? 'Read complete: LOCAL_READ_SENTINEL_93d26'
        : 'Mock task complete.'
  writeSse(response, [
    { type: 'message_start', message: { id: 'msg_text', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ])
})

function writeSse(response, records) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const record of records) response.write(`event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`)
  response.end()
}

async function collect(stream) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

async function collectWithTimeout(stream, stage) {
  return withTimeout(collect(stream), 60_000, `${stage} did not finish within 60 seconds`)
}

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const env = {
  ...process.env,
  DEEPSEEK_API_KEY: 'smoke-key-not-for-production',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
}
const agent = await createAgentPackage({ workspace, stateDir, env, config: { model: 'deepseek-flash' } })
const taskModel = 'deepseek-v4-pro'

try {
  process.stdout.write('smoke: original runtime tool/read-file roundtrip…\n')
  const first = await collectWithTimeout(agent.executeTask({ taskId: 'read-roundtrip', input: 'READ_FILE: read probe.txt and report its contents', sessionId: 'smoke-conversation', model: taskModel }), 'read roundtrip')
  assert.equal(first.some(event => event.type === 'tool-call' && event.name === 'read'), true, 'original headless runtime should emit a read tool call')
  assert.equal(first.some(event => event.type === 'tool-result' && String(event.output).includes('LOCAL_READ_SENTINEL_93d26')), true, 'the original read tool should return the local file contents')
  assert.equal(first.findLast(event => event.type === 'assistant-replace')?.text.includes('LOCAL_READ_SENTINEL_93d26'), true, 'the final answer should include the tool result')
  assert.deepEqual(requests.slice(0, 2).map(({ body }) => body.model), [taskModel, taskModel], 'each request in the selected task should use its task model')

  const sessionId = first.find(event => event.type === 'session')?.sessionId
  assert.ok(sessionId, 'headless JSON stream should publish its durable session id')
  process.stdout.write('smoke: second turn with persisted conversation history…\n')
  const second = await collectWithTimeout(agent.executeTask({ taskId: 'second-turn', input: 'SECOND_TURN: Continue this conversation', sessionId: 'smoke-conversation', model: taskModel }), 'second turn')
  assert.equal(second.find(event => event.type === 'assistant-replace')?.text, 'Second task used the existing session.')
  assert.equal(requests.at(-1)?.body.model, taskModel, 'a new task resuming the session should keep its selected model')
  const secondHistory = JSON.stringify(requests.at(-1)?.body.messages ?? [])
  assert.match(secondHistory, /READ_FILE/)
  assert.match(secondHistory, /tool_result/)
  assert.match(secondHistory, /LOCAL_READ_SENTINEL_93d26/)

  const cancelController = new AbortController()
  const cancelStream = agent.executeTask({ taskId: 'cancel-turn', input: 'HANG_FOR_CANCEL', sessionId: 'smoke-conversation' }, { signal: cancelController.signal })
  const cancelEvents = []
  const consume = (async () => { for await (const event of cancelStream) cancelEvents.push(event) })()
  await withTimeout(hangStarted, 20_000, 'mock model request did not start')
  cancelController.abort()
  await consume
  assert.equal(cancelEvents.at(-1)?.type, 'cancelled')
  if (pendingHang && !pendingHang.destroyed) pendingHang.destroy()

  process.stdout.write('smoke: cancel and resume the same persisted session…\n')
  const resumed = await collectWithTimeout(agent.executeTask({ taskId: 'resume-after-cancel', input: 'RESUME_AFTER_CANCEL and continue the conversation', sessionId: 'smoke-conversation' }), 'resume after cancel')
  assert.equal(resumed.find(event => event.type === 'assistant-replace')?.text, 'Recovered the prior session after cancellation.')
  assert.match(JSON.stringify(requests.at(-1)?.body.messages ?? []), /HANG_FOR_CANCEL/)

  process.stdout.write('smoke: provider error propagation…\n')
  const failure = await collectWithTimeout(agent.executeTask({ taskId: 'provider-error', input: 'FORCE_PROVIDER_ERROR' }), 'provider failure')
  const providerError = failure.find(event => event.type === 'error')
  assert.match(providerError?.message ?? '', /^AUTH: fixture provider rejection/, 'turn/end error details and code must reach TaskEvents')
  assert.equal(providerError.message.includes('smoke-key-not-for-production'), false, 'provider details must redact credentials')
  assert.equal(failure.filter(event => event.type === 'error').length, 1, 'provider failure must surface once')
  assert.equal(failure.some(event => event.type === 'assistant-complete'), false, 'a final event with a failing turn must not be marked successful')

  process.stdout.write('DeepSeek original headless runtime smoke passed: tool/read-file, multi-turn session, cancel/resume, provider error.\n')
} finally {
  await agent.dispose()
  if (pendingHang && !pendingHang.destroyed) pendingHang.destroy()
  server.closeAllConnections()
  server.close()
  await once(server, 'close')
  await rm(temporary, { recursive: true, force: true })
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
