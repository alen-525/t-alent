import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib'
import { createAgentPackage } from '../src/index.mjs'

const timeoutMs = 30_000
const fakeApiKey = 'CODEX_SMOKE_FAKE_KEY_8c2d0d'
const sentinel = `CODEX_SMOKE_FILE_${randomUUID()}`
const workspace = await mkdtemp(join(tmpdir(), 't-alent-codex-workspace-'))
const stateDir = await mkdtemp(join(tmpdir(), 't-alent-codex-state-'))
const filePath = join(workspace, 'sentinel.txt')
const programPath = join(workspace, 'program.mjs')
await writeFile(filePath, `${sentinel}\n`)
await writeFile(programPath, `export function transformInput(input) { return 'PROGRAM_TRANSFORMED: ' + input }\n`)

let currentAgent
let activeController
let hangingRequestClosed
let resolveHangingRequestClosed
let requestOrdinal = 0
const requestLog = []
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
      return
    }
    const body = await readRequestJson(req)
    const call = { ordinal: ++requestOrdinal, body }
    requestLog.push(call)
    const input = Array.isArray(body?.input) ? body.input : []
    const flat = JSON.stringify(input)
    const latestPrompt = latestUserPrompt(input)

    if (latestPrompt.includes('SMOKE_HANG_UNTIL_CANCEL')) {
      hangingRequestClosed = new Promise(resolveClosed => { resolveHangingRequestClosed = resolveClosed })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(sse({ type: 'response.created', response: { id: `resp-hang-${call.ordinal}` } }))
      const deadline = setTimeout(() => res.end(sse(completed(`resp-hang-${call.ordinal}`))), 20_000)
      res.once('close', () => { clearTimeout(deadline); resolveHangingRequestClosed?.() })
      return
    }

    if (latestPrompt.includes('SMOKE_HTTP_401')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unauthorized ${fakeApiKey}`, type: 'invalid_request_error', code: 'invalid_api_key' } }))
      return
    }

    if (latestPrompt.includes('SMOKE_RESPONSE_FAILED')) {
      sendSse(res, [
        { type: 'response.created', response: { id: `resp-failed-${call.ordinal}` } },
        { type: 'response.failed', response: { id: `resp-failed-${call.ordinal}`, status: 'failed', error: { code: 'test_provider_failure', type: 'server_error', message: `Provider fixture detail ${fakeApiKey}` } } },
      ])
      return
    }

    if (latestPrompt.includes('SMOKE_FIRST_READ')) {
      const functionOutput = input.find(item => item?.type === 'function_call_output' && item.call_id === 'smoke-read-file-call')
      if (functionOutput) {
        assert.match(JSON.stringify(functionOutput), new RegExp(sentinel))
        sendSse(res, finalAnswer(`Read verified: ${sentinel}`))
        return
      }
      assert.match(latestPrompt, /PROGRAM_TRANSFORMED: SMOKE_FIRST_READ/)
      const command = `cat ${shellQuote(filePath)}`
      sendSse(res, [
        { type: 'response.created', response: { id: `resp-read-${call.ordinal}` } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'smoke-read-file-call', name: 'exec_command', arguments: JSON.stringify({ cmd: command, workdir: workspace, yield_time_ms: 1000 }) } },
        completed(`resp-read-${call.ordinal}`),
      ])
      return
    }

    if (latestPrompt.includes('SMOKE_PERSISTED_SECOND_TURN')) {
      sendSse(res, finalAnswer('PERSISTED_SECOND_TURN_OK'))
      return
    }

    if (latestPrompt.includes('SMOKE_AFTER_CANCEL')) {
      sendSse(res, finalAnswer('RESUMED_AFTER_CANCEL_OK'))
      return
    }

    if (latestPrompt.includes('SMOKE_CROSS_FACTORY')) {
      sendSse(res, finalAnswer('CROSS_FACTORY_HISTORY_OK'))
      return
    }

    sendSse(res, finalAnswer('UNEXPECTED_MOCK_REQUEST'))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `mock fixture failed: ${error.message}`, type: 'server_error', code: 'mock_fixture_failure' } }))
  }
})

let baseUrl

function logStage(message) { process.stdout.write(`[codex-smoke] ${message}\n`) }
function runtimeConfig() {
  return {
    program: 'program.mjs',
    cancelGraceMs: 1500,
    codexConfig: {
      model: 'codex-smoke-model',
      model_provider: 'mock',
      model_providers: {
        mock: {
          name: 'local Codex runtime smoke fixture',
          base_url: baseUrl,
          wire_api: 'responses',
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
    },
  }
}
function createAgent() {
  return createAgentPackage({
    workspace,
    stateDir,
    env: { CODEX_API_KEY: fakeApiKey, OPENAI_API_KEY: '' },
    config: runtimeConfig(),
  })
}
async function collectTask(agent, taskId, input, sessionId, controller = new AbortController()) {
  activeController = controller
  const events = []
  await withTimeout((async () => {
    for await (const event of agent.executeTask({ taskId, input, sessionId }, { signal: controller.signal })) events.push(event)
  })(), timeoutMs, `task ${taskId}`)
  activeController = null
  return events
}
function assertNoSecret(events) {
  assert.equal(JSON.stringify(events).includes(fakeApiKey), false, 'fixture API key must never appear in host events')
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}/v1`
  logStage('start private Responses SSE mock and Codex runtime')
  currentAgent = await createAgent()

  logStage('real Codex shell tool reads a workspace file; transformed prompt reaches provider')
  const first = await collectTask(currentAgent, 'first-read', 'SMOKE_FIRST_READ', 'smoke-conversation')
  const shellCall = first.find(event => event.type === 'tool-call')
  assert.ok(shellCall && /sentinel\.txt/.test(shellCall.name), `expected original Codex shell tool event to run cat on the workspace file; got ${JSON.stringify(shellCall)}`)
  assert.ok(first.some(event => event.type === 'tool-result' && JSON.stringify(event).includes(sentinel)), 'expected original Codex shell result to contain file sentinel')
  assert.ok(first.some(event => event.type === 'assistant-replace' && event.text.includes(sentinel)), 'expected final answer to use the file contents')
  assert.ok(requestLog.some(({ body }) => JSON.stringify(body.input).includes('PROGRAM_TRANSFORMED: SMOKE_FIRST_READ')), 'provider must receive the program-transformed input')
  const toolFollowup = requestLog.find(({ body }) => JSON.stringify(body.input).includes(sentinel) && JSON.stringify(body.input).includes('function_call_output'))
  assert.ok(toolFollowup, 'second provider request must include Codex function_call_output containing the actual shell result')
  assertNoSecret(first)

  logStage('continue history in the same persistent App Server thread')
  const second = await collectTask(currentAgent, 'second-turn', 'SMOKE_PERSISTED_SECOND_TURN', 'smoke-conversation')
  assert.ok(second.some(event => event.type === 'assistant-replace' && event.text === 'PERSISTED_SECOND_TURN_OK'))
  const secondRequest = requestLog.find(({ body }) => JSON.stringify(body.input).includes('SMOKE_PERSISTED_SECOND_TURN'))
  assert.ok(secondRequest, 'expected provider call for the second turn')
  assert.ok(JSON.stringify(secondRequest.body.input).includes(sentinel), 'resumed model input should retain prior shell output/history')

  logStage('cancel a deliberately hanging provider request, then resume its conversation')
  activeController = new AbortController()
  const hangingEvents = []
  const hangingTask = (async () => {
    for await (const event of currentAgent.executeTask({ taskId: 'cancel-turn', input: 'SMOKE_HANG_UNTIL_CANCEL', sessionId: 'smoke-conversation' }, { signal: activeController.signal })) hangingEvents.push(event)
  })()
  await withTimeout(waitFor(() => requestLog.some(({ body }) => JSON.stringify(body.input).includes('SMOKE_HANG_UNTIL_CANCEL'))), 12_000, 'hanging provider request start')
  activeController.abort()
  await withTimeout(hangingTask, 12_000, 'cancelled task cleanup')
  assert.ok(hangingEvents.some(event => event.type === 'cancelled'), 'expected one cancellation event')
  if (hangingRequestClosed) await withTimeout(hangingRequestClosed, 5_000, 'hanging request close')
  activeController = null
  const afterCancel = await collectTask(currentAgent, 'after-cancel', 'SMOKE_AFTER_CANCEL', 'smoke-conversation')
  assert.ok(afterCancel.some(event => event.type === 'assistant-replace' && event.text === 'RESUMED_AFTER_CANCEL_OK'))

  logStage('dispose and recreate package factory; resume the same persisted conversation')
  await currentAgent.dispose()
  currentAgent = await createAgent()
  const crossFactory = await collectTask(currentAgent, 'cross-factory', 'SMOKE_CROSS_FACTORY', 'smoke-conversation')
  assert.ok(crossFactory.some(event => event.type === 'assistant-replace' && event.text === 'CROSS_FACTORY_HISTORY_OK'))
  const crossFactoryRequest = requestLog.find(({ body }) => JSON.stringify(body.input).includes('SMOKE_CROSS_FACTORY'))
  assert.ok(crossFactoryRequest && JSON.stringify(crossFactoryRequest.body.input).includes('PERSISTED_SECOND_TURN_OK'), 'history should survive factory recreation')

  logStage('surface an HTTP 401 provider failure without exposing the fake key')
  const http401 = await collectTask(currentAgent, 'provider-401', 'SMOKE_HTTP_401', 'smoke-401')
  assert.ok(http401.some(event => event.type === 'error'), 'expected an error event for HTTP 401')
  assertNoSecret(http401)

  logStage('surface response.failed code and detail without exposing the fake key')
  const responseFailed = await collectTask(currentAgent, 'response-failed', 'SMOKE_RESPONSE_FAILED', 'smoke-response-failed')
  const providerError = responseFailed.find(event => event.type === 'error')
  assert.ok(providerError, 'expected an error event for response.failed')
  assert.match(providerError.message, /test_provider_failure|Provider fixture detail/, 'expected upstream provider failure code or detail')
  assertNoSecret(responseFailed)

  logStage(`passed: ${requestLog.length} real Codex Responses request(s); no paid API used`)
} catch (error) {
  activeController?.abort()
  throw error
} finally {
  activeController?.abort()
  if (currentAgent) await currentAgent.dispose().catch(() => {})
  if (server.listening) {
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(() => resolveClose()))
  }
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(stateDir, { recursive: true, force: true }),
  ])
}

function sse(event) {
  if (!event) return ''
  const type = event.type
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
}
function sendSse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
  for (const event of events) res.write(sse(event))
  res.end()
}
function completed(id) {
  return { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }
}
function finalAnswer(text) {
  const id = `resp-final-${requestOrdinal}`
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${requestOrdinal}`, content: [{ type: 'output_text', text }] } },
    completed(id),
  ]
}
async function readRequestJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let bytes = Buffer.concat(chunks)
  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase()
  if (encoding === 'gzip') bytes = gunzipSync(bytes)
  else if (encoding === 'deflate') bytes = inflateSync(bytes)
  else if (encoding === 'br') bytes = brotliDecompressSync(bytes)
  else if (encoding === 'zstd') bytes = zstdDecompressSync(bytes)
  else if (encoding && encoding !== 'identity') throw new Error(`unsupported request content-encoding: ${encoding}`)
  return JSON.parse(bytes.toString('utf8'))
}
function shellQuote(text) { return `'${text.replaceAll("'", "'\\''")}'` }
function latestUserPrompt(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (item?.type !== 'message' || item.role !== 'user') continue
    return JSON.stringify(item)
  }
  return JSON.stringify(input)
}
function waitFor(predicate, ms = 10_000) {
  return new Promise((resolveWait, reject) => {
    let interval
    const timer = setTimeout(() => finish(new Error(`timed out waiting ${ms}ms for expected provider request`)), ms)
    function finish(error) {
      clearTimeout(timer)
      clearInterval(interval)
      if (error) reject(error)
      else resolveWait()
    }
    interval = setInterval(() => {
      try { if (predicate()) finish() } catch (error) { finish(error) }
    }, 25)
    try { if (predicate()) finish() } catch (error) { finish(error) }
  })
}
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}
