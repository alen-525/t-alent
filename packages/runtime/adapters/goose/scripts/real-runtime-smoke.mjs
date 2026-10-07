import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const program = process.env.GOOSE_BIN ?? process.env.TALENT_GOOSE_BIN
if (!program) throw new Error('Set GOOSE_BIN or TALENT_GOOSE_BIN to the locally available official Goose v1.48.0 CLI; the smoke test never downloads or installs it.')
const apiKey = 'goose-smoke-secret'
const requests = []
let cancelRequestSeen
const cancellationRequest = new Promise(resolveSeen => { cancelRequestSeen = resolveSeen })
let cancelSocket = null
let chatCount = 0

const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body
  try { body = JSON.parse(raw) } catch { body = {} }
  requests.push({ url: request.url, authorization: request.headers.authorization, body })
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'goose-smoke-model', object: 'model' }] }))
    return
  }
  if (String(body.messages?.at(-1)?.content ?? '').includes('cancel smoke')) {
    cancelSocket = response
    cancelRequestSeen()
    return
  }
  if (String(body.messages?.at(-1)?.content ?? '').includes('error smoke')) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `bad api key ${apiKey}` } }))
    return
  }

  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  chatCount += 1
  if (chatCount === 1) {
    const shellTool = body.tools?.find(tool => /shell/i.test(tool.function?.name ?? tool.name ?? ''))
    if (!shellTool) {
      response.write(`data: ${JSON.stringify({ error: { message: 'Goose request did not expose a shell tool' } })}\n\n`)
      response.end()
      return
    }
    const name = shellTool.function?.name ?? shellTool.name
    const chunk = { id: 'goose-smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'smoke-call-1', type: 'function', function: { name, arguments: JSON.stringify({ command: 'printf goose-smoke-tool' }) } }] }, finish_reason: null }] }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'goose-smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify({ id: 'goose-smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'GOOSE_SMOKE_OK' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'goose-smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
})

const temp = await mkdtemp(join(os.tmpdir(), 'talent-goose-smoke-'))
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const options = {
    workspace: temp,
    stateDir: join(temp, 'state'),
    env: { GOOSE_BIN: program, GOOSE_SMOKE_KEY: apiKey },
    config: { cancelGraceMs: 500 },
  }
  let agent = await createAgentPackage(options)
  const profile = { id: 'goose-local-smoke', name: 'Goose mock', provider: 'mock', model: 'goose-smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'GOOSE_SMOKE_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1` }
  try {
    const first = []
    for await (const event of agent.executeTask({ taskId: 'goose-smoke-1', input: 'Run the shell tool to print goose-smoke-tool then reply GOOSE_SMOKE_OK.', sessionId: 'goose-smoke-conversation', model: profile })) first.push(event)
    assert(first.some(event => event.type === 'tool-call' && /shell/i.test(event.name)))
    assert(first.some(event => event.type === 'tool-result' && event.output.includes('goose-smoke-tool')))
    assert(first.some(event => event.type === 'assistant-complete'))
    assert(JSON.stringify(first).includes('GOOSE_SMOKE_OK'))

    await agent.dispose(); agent = await createAgentPackage(options)
    const second = []
    for await (const event of agent.executeTask({ taskId: 'goose-smoke-2', input: 'Continue this saved conversation and reply GOOSE_SMOKE_OK.', sessionId: 'goose-smoke-conversation', model: profile })) second.push(event)
    assert(second.some(event => event.type === 'assistant-complete'))

    const errorEvents = []
    for await (const event of agent.executeTask({ taskId: 'goose-smoke-error', input: 'error smoke', sessionId: 'goose-smoke-error-conversation', model: profile })) errorEvents.push(event)
    assert(errorEvents.some(event => event.type === 'error'))
    assert.equal(JSON.stringify(errorEvents).includes(apiKey), false)

    const pending = agent.executeTask({ taskId: 'goose-smoke-cancel', input: 'cancel smoke', sessionId: 'goose-smoke-cancel-conversation', model: profile })
    const pendingEvents = []
    const consume = (async () => { for await (const event of pending) pendingEvents.push(event) })()
    let cancellationTimer
    try {
      await Promise.race([cancellationRequest, new Promise((_, reject) => { cancellationTimer = setTimeout(() => reject(new Error('Goose did not reach the local mock endpoint during cancellation test')), 15_000) })])
    } finally {
      clearTimeout(cancellationTimer)
    }
    await agent.cancelTask('goose-smoke-cancel')
    await consume
    assert(pendingEvents.some(event => event.type === 'cancelled'))

    const recovered = []
    for await (const e of agent.executeTask({ taskId: 'recovered', input: 'Continue after cancelled task.', sessionId: 'goose-smoke-cancel-conversation', model: profile })) recovered.push(e)
    assert(recovered.some(e => e.type === 'assistant-complete'))
    assert(requests.some(r => r.body.messages?.some(m => m.role === 'tool' && JSON.stringify(m).includes('goose-smoke-tool'))), 'Native tool output must return to the model')
    assert(!errorEvents.some(e => e.type === 'assistant-complete'))
    assert(requests.length >= 5)
    assert(requests.every(item => item.authorization === `Bearer ${apiKey}`))
    assert(requests.filter(item => item.url === '/v1/chat/completions').every(item => item.body.model === profile.model))
    assert(requests.filter(item => item.url !== '/v1/models').every(item => item.url === '/v1/chat/completions'))
    const resumedRequest = requests.find(item => item.body.messages?.some(message => JSON.stringify(message).includes('Run the shell tool')) && JSON.stringify(item.body.messages).includes('Continue this saved conversation'))
    assert(resumedRequest, 'the second task should include prior conversation context from Goose session storage')
    assert.equal(JSON.stringify(first.concat(second, pendingEvents)).includes(apiKey), false)
    console.log(`Goose v1.48.0 smoke passed: ${requests.length} local mock requests, native tool execution/return, cross-instance history, profile routing, provider error, cancellation/recovery.`)
  } finally {
    await agent.dispose()
  }
} finally {
  if (cancelSocket && !cancelSocket.writableEnded) cancelSocket.destroy()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(temp, { recursive: true, force: true })
}
