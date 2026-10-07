import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(os.tmpdir(), 'talent-aider-real-smoke-'))
const workspace = join(temp, 'repo')
const stateDir = join(temp, 'state')
await mkdir(workspace, { recursive: true })
const aider = resolve('.talent/aider/aider-runtime/venv/bin/aider')
const key = 'smoke-secret-92'
let mode = 'edit-first'
let calls = 0
const requests = []
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'smoke-model', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push({ body, authorization: req.headers.authorization })
  calls += 1
  if (mode === 'hang') {
    req.on('close', () => {})
    return
  }
  if (mode === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock authentication failure' } })); return }
  const full = JSON.stringify(body.messages)
  let content
  if (full.includes('append second proof')) {
    content = 'sample.txt\n```\n<<<<<<< SEARCH\nalpha\nfirst proof\n=======\nalpha\nfirst proof\nsecond proof\n>>>>>>> REPLACE\n```'
  } else {
    content = 'sample.txt\n```\n<<<<<<< SEARCH\nalpha\n=======\nalpha\nfirst proof\n>>>>>>> REPLACE\n```'
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: `chatcmpl-${calls}`, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
})

let agent
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  const env = { AIDER_BIN: aider, SMOKE_AIDER_KEY: key, OPENAI_API_KEY: 'inherited-should-be-removed', OPENAI_API_BASE: 'http://wrong-host/v1', AIDER_MODEL: 'inherited-wrong-model' }
  await writeFile(join(workspace, 'sample.txt'), 'alpha\n')
  await run('git', ['init', '-q'], workspace)
  agent = await createAgentPackage({ workspace, stateDir, env, config: { program: aider, cancelGraceMs: 400, files: ['sample.txt'] } })
  const profile = { id: 'aider-smoke', provider: 'openai', model: 'smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'SMOKE_AIDER_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1` }

  let events = await collect(agent, 'smoke-first', 'conversation', profile, 'Read sample.txt and append first proof on its own line.')
  assert.equal((await readFile(join(workspace, 'sample.txt'), 'utf8')), 'alpha\nfirst proof\n', `Aider must read and change the actual workspace file through its own editing loop; events=${JSON.stringify(events)}`)
  assert(events.some(event => event.type === 'assistant-complete'))
  assert(requests.some(request => request.authorization === `Bearer ${key}`))
  // LiteLLM removes its `openai/` provider prefix before placing the deployment name in the API body.
  assert(requests.every(request => request.body.model === 'smoke-model'))
  assert(requests.some(request => JSON.stringify(request.body.messages).includes('alpha')), `Aider request must include the workspace file content; request: ${JSON.stringify(requests[0]?.body.messages).slice(-1800)}`)

  events = await collect(agent, 'smoke-resume', 'conversation', profile, 'Using the same conversation, append second proof on its own line.')
  assert.equal((await readFile(join(workspace, 'sample.txt'), 'utf8')), 'alpha\nfirst proof\nsecond proof\n', 'the follow-up must use the Aider history and continue editing')
  assert(events.some(event => event.type === 'assistant-complete'))

  mode = 'hang'
  const controller = new AbortController()
  const cancelIterator = agent.executeTask({ taskId: 'smoke-cancel', input: 'Wait for the provider response.', sessionId: 'cancel-conversation', model: profile }, { signal: controller.signal })[Symbol.asyncIterator]()
  const requestDeadline = Date.now() + 15_000
  while (Date.now() < requestDeadline && calls < 3) await new Promise(resolveWait => setTimeout(resolveWait, 40))
  assert(calls >= 3, 'Aider should start a provider request before cancellation')
  controller.abort()
  const cancelled = []
  for await (const event of { [Symbol.asyncIterator]: () => cancelIterator }) cancelled.push(event)
  assert(cancelled.some(event => event.type === 'cancelled'))

  mode = 'fail'
  events = await collect(agent, 'smoke-fail', 'failure-conversation', profile, 'Make an unrelated change.')
  assert(events.some(event => event.type === 'error'), `provider failure must be reported as an error: ${JSON.stringify(events)}`)
  assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  assert.equal(JSON.stringify(events).includes(key), false)
  console.log(`Aider v0.86.2 real-runtime smoke passed: ${calls} mock calls; edit, resume, cancellation, and error paths verified.`)
} finally {
  await agent?.dispose()
  await new Promise(resolveClose => server.close(() => resolveClose()))
  await rm(temp, { recursive: true, force: true })
}

async function collect(instance, taskId, sessionId, model, input) {
  const events = []
  for await (const event of instance.executeTask({ taskId, sessionId, model, input })) events.push(event)
  return events
}
async function run(command, argv, cwd) {
  return await new Promise((resolveRun, reject) => {
    const child = nodeSpawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => output += chunk)
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} failed (${code}): ${output}`)))
  })
}
