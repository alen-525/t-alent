import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const temp = await mkdtemp(join(os.tmpdir(), 'talent-nanobot-smoke-'))
const workspace = join(temp, 'repo')
const stateDir = join(temp, 'state')
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'sample.txt'), 'alpha\n')
const repoRoot = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const configuredPython = process.env.TALENT_NANOBOT_PYTHON ?? process.env.NANOBOT_PYTHON
const python = configuredPython ? resolve(configuredPython) : resolve(repoRoot, '.talent/nanobot/nanobot-runtime/venv/bin', process.platform === 'win32' ? 'python.exe' : 'python')
const key = 'nanobot-smoke-secret-913'
let mode = 'normal'
let calls = 0
const requests = []
let hangingResponse
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push({ body, authorization: req.headers.authorization, path: req.url })
  calls += 1
  if (mode === 'hang') { hangingResponse = res; return }
  if (mode === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'mock unauthorized' } })); return }
  const content = calls === 1 ? null : 'Nanobot read alpha from the project file.'
  const toolCalls = calls === 1 ? [{ index: 0, id: 'nanobot-call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'sample.txt' }) } }] : undefined
  const payload = { id: `nano-${calls}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', ...(content ? { content } : {}), ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] }
  const finish = { id: `nano-${calls}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
  res.write(`data: ${JSON.stringify(finish)}\n\n`)
  res.end('data: [DONE]\n\n')
})
let agent
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  const port = server.address().port
  agent = await createAgentPackage({ workspace, stateDir, env: { NANO_SMOKE_KEY: key }, config: { python, cancelGraceMs: 1200 } })
  const profile = { id: 'nanobot-smoke', name: 'Smoke model', provider: 'arbitrary compatible host label', model: 'openai/foo', protocol: 'openai-chat-completions', apiKeyEnv: 'NANO_SMOKE_KEY', baseUrl: `http://127.0.0.1:${port}/v1` }
  let events = await collect(agent, 'first', 'resume-session', profile, 'Read sample.txt in the first Nanobot turn.')
  assert(events.some(event => event.type === 'tool-call' && event.name === 'read_file'), JSON.stringify(events))
  assert(events.some(event => event.type === 'tool-result' && event.name === 'read_file'), JSON.stringify(events))
  assert(events.some(event => event.type === 'assistant-complete'), JSON.stringify(events))
  assert(requests.length >= 2)
  assert(requests.every(request => request.authorization === `Bearer ${key}` && request.body.model === 'openai/foo'), JSON.stringify(requests.map(request => ({ model: request.body.model, auth: Boolean(request.authorization) }))))
  const advertised = toolNames(requests[0].body)
  assert(advertised.includes('read_file') && advertised.includes('exec'))
  assert(advertised.every(name => ['read_file', 'write_file', 'edit_file', 'list_dir', 'find_files', 'grep', 'apply_patch', 'exec', 'exec_session', 'list_exec_sessions'].includes(name)), JSON.stringify(advertised))
  const firstCount = requests.length
  events = await collect(agent, 'second', 'resume-session', profile, 'Using the earlier file observation, what did it contain?')
  assert(events.some(event => event.type === 'assistant-complete'), JSON.stringify(events))
  assert(requests.slice(firstCount).some(request => JSON.stringify(request.body.messages).includes('Read sample.txt in the first Nanobot turn.')), 'native SDK session history should resume across worker processes')

  const profileCount = requests.length
  const alternate = { ...profile, id: 'other-model', model: 'openai/alternate' }
  events = await collect(agent, 'alternate', 'resume-session', alternate, 'This profile starts an isolated conversation.')
  assert(events.some(event => event.type === 'assistant-complete'))
  assert.equal(JSON.stringify(requests[profileCount].body.messages).includes('Read sample.txt in the first Nanobot turn.'), false, 'native session history must be isolated by full model profile')

  mode = 'hang'
  const controller = new AbortController()
  const iterator = agent.executeTask({ taskId: 'cancel', sessionId: 'cancel-session', model: profile, input: 'Wait on the mock provider.' }, { signal: controller.signal })[Symbol.asyncIterator]()
  const before = calls
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && calls === before) await new Promise(resolveWait => setTimeout(resolveWait, 30))
  assert(calls > before, 'SDK should start a provider request before cancellation')
  controller.abort()
  const cancelled = []; for await (const event of { [Symbol.asyncIterator]: () => iterator }) cancelled.push(event)
  assert(cancelled.some(event => event.type === 'cancelled'))
  hangingResponse?.destroy()
  mode = 'normal'
  events = await collect(agent, 'recovery', 'cancel-session', profile, 'Continue after the cancelled provider request.')
  assert(events.some(event => event.type === 'assistant-complete'), JSON.stringify(events))

  mode = 'fail'
  events = await collect(agent, 'failure', 'failure-session', profile, 'Trigger provider authentication failure.')
  assert(events.some(event => event.type === 'error'), JSON.stringify(events))
  assert.equal(events.some(event => event.type === 'assistant-complete'), false)
  assert.equal(JSON.stringify(events).includes(key), false)
  assert.equal(requests.some(request => JSON.stringify(request.body).includes(key)), false)
  for (const file of await walkFiles(stateDir)) assert.equal((await readFile(file, 'utf8')).includes(key), false, `credential persisted in ${file}`)
  console.log(`Nanobot ${'0.3.5'} SDK smoke passed: native AgentLoop/file tool/session recovery, exact arbitrary model route, workspace/profile isolation, cancellation recovery, HTTP 401, coding-only tool registry, and no persisted API key.`)
} finally {
  hangingResponse?.destroy()
  await agent?.dispose()
  await new Promise(resolveClose => server.close(() => resolveClose()))
  await rm(temp, { recursive: true, force: true })
}

async function collect(instance, taskId, sessionId, model, input) { const events = []; for await (const event of instance.executeTask({ taskId, sessionId, model, input })) events.push(event); return events }
function toolNames(body) { return (body.tools ?? []).map(item => item.function?.name ?? item.name).filter(Boolean) }
async function walkFiles(root) { const results = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) results.push(...await walkFiles(path)); else if (entry.isFile()) results.push(path) }; return results }
