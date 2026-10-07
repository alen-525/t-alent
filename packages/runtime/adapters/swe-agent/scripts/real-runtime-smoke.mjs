import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentPackage } from '../src/index.mjs'

const root = resolve(import.meta.dirname, '../../../../../')
const state = await mkdtemp(join(tmpdir(), 'talent-swe-agent-real-'))
const workspace = join(state, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'probe.txt'), 'SWE_AGENT_NATIVE_OBSERVATION_b59e\n')
const seen = []
let keyChecks = 0
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url === '/fail/v1/chat/completions') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'local provider failure' } }))
    return
  }
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer swe-agent-local-smoke-key')
  keyChecks++
  const body = JSON.parse(raw)
  assert(['swe-smoke-model', 'other-swe-model'].includes(body.model))
  const dump = JSON.stringify(body.messages)
  seen.push(dump)
  const text = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  if (text.includes('PRIMARY SWE-AGENT NATIVE SMOKE')) {
    answer(res, dump.includes('SWE_AGENT_NATIVE_OBSERVATION_b59e') ? action('exit') : action('if [ -n "$SWE_AGENT_LOCAL_SMOKE_KEY" ]; then exit 73; else cat probe.txt; fi'))
  } else if (text.includes('FOLLOWUP SWE-AGENT NATIVE SMOKE')) {
    assert(dump.includes('HISTORY_TASK_MARKER_d011'), 'host session history should reach the next native model query')
    answer(res, action('exit'))
  } else if (text.includes('ISOLATION SWE-AGENT NATIVE SMOKE')) {
    assert(!dump.includes('HISTORY_TASK_MARKER_d011'), 'different model profile must have independent session history')
    answer(res, action('exit'))
  } else if (text.includes('CANCEL SWE-AGENT NATIVE SMOKE')) {
    answer(res, action('sleep 30'))
  } else if (text.includes('RECOVER SWE-AGENT NATIVE SMOKE')) {
    answer(res, action('exit'))
  } else if (text.includes('FAILURE SWE-AGENT NATIVE SMOKE')) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'local provider failure' } }))
  } else {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unexpected native SWE-agent task ${text.slice(0, 120)}` } }))
  }
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}/v1`
const profile = { id: 'local-swe-smoke', provider: 'external-provider-label', model: 'swe-smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'SWE_AGENT_LOCAL_SMOKE_KEY', baseUrl }
const env = { ...process.env, SWE_AGENT_LOCAL_SMOKE_KEY: 'swe-agent-local-smoke-key', OPENAI_API_KEY: 'wrong-ambient-key', SWE_AGENT_MODEL: 'wrong-ambient-model' }
const pkg = await createAgentPackage({
  workspace,
  stateDir: join(state, 'state'),
  env,
  config: { python: process.env.TALENT_SWE_AGENT_PYTHON ?? process.env.SWE_AGENT_PYTHON ?? resolve(root, '.talent/swe-agent/swe-agent-runtime/venv/bin/python'), stepLimit: 12, cancelGraceMs: 3000 },
})
const sessionId = `native-${randomUUID()}`
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
try {
  const primary = await collect(pkg.executeTask({ taskId: 'primary', sessionId, input: 'PRIMARY SWE-AGENT NATIVE SMOKE; history marker HISTORY_TASK_MARKER_d011', model: profile }))
  assert(primary.some(event => event.type === 'tool-call' && event.input.includes('cat probe.txt')))
  assert(primary.some(event => event.type === 'tool-result' && event.output.includes('SWE_AGENT_NATIVE_OBSERVATION_b59e')))
  assert.equal(primary.at(-1).type, 'assistant-complete')
  assert(seen.some(messages => messages.includes('SWE_AGENT_NATIVE_OBSERVATION_b59e')), 'SWE-ReX observation must be included in the next model request')

  const follow = await collect(pkg.executeTask({ taskId: 'follow', sessionId, input: 'FOLLOWUP SWE-AGENT NATIVE SMOKE', model: profile }))
  assert.equal(follow.at(-1).type, 'assistant-complete')
  const isolated = await collect(pkg.executeTask({ taskId: 'isolated', sessionId, input: 'ISOLATION SWE-AGENT NATIVE SMOKE', model: { ...profile, id: 'local-swe-other', model: 'other-swe-model' } }))
  assert.equal(isolated.at(-1).type, 'assistant-complete')

  const cancelStream = pkg.executeTask({ taskId: 'cancel', sessionId, input: 'CANCEL SWE-AGENT NATIVE SMOKE', model: profile })
  const cancelEvents = []
  let toolStartedResolve
  const toolStarted = new Promise(resolveStarted => { toolStartedResolve = resolveStarted })
  const reader = (async () => { for await (const event of cancelStream) { cancelEvents.push(event); if (event.type === 'tool-call') toolStartedResolve() } })()
  await Promise.race([toolStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('SWE-ReX sleep action did not start')), 20_000))])
  await pkg.cancelTask('cancel')
  await reader
  assert(cancelEvents.some(event => event.type === 'cancelled'))
  const recovered = await collect(pkg.executeTask({ taskId: 'recovery', sessionId, input: 'RECOVER SWE-AGENT NATIVE SMOKE', model: profile }))
  assert.equal(recovered.at(-1).type, 'assistant-complete')

  const failed = await collect(pkg.executeTask({ taskId: 'failure', sessionId, input: 'FAILURE SWE-AGENT NATIVE SMOKE', model: { ...profile, id: 'local-swe-failure', baseUrl: `http://127.0.0.1:${port}/fail/v1` } }))
  assert(failed.some(event => event.type === 'error'))
  assert(keyChecks >= 1)
  for (const file of await walk(state)) if (file.endsWith('.json') || file.endsWith('.traj')) assert(!(await readFile(file, 'utf8')).includes('swe-agent-local-smoke-key'), `credential persisted in ${file}`)
  console.log('SWE-agent v1.1.0 + SWE-ReX 1.4.0 native LocalDeployment smoke passed: bash observation -> model, session history, route isolation, cancel/recovery, provider failure, credential scan; Docker not used')
} finally {
  await pkg.dispose()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(state, { recursive: true, force: true })
}

function action(command) { return { id: `call-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } } }
function answer(res, toolCall) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: 'swe-smoke-model', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [toolCall] } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }))
}
async function walk(dir) { const found = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) found.push(...await walk(path)); else found.push(path) } return found }
