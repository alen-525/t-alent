import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentPackage } from '../src/index.mjs'

const root = resolve(import.meta.dirname, '../../../../../')
const state = await mkdtemp(join(tmpdir(), 'talent-mini-swe-real-'))
const workspace = join(state, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'probe.txt'), 'NATIVE_SHELL_READ_91c73\n')
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
  assert.equal(req.headers.authorization, 'Bearer local-mini-swe-smoke-key')
  keyChecks++
  const body = JSON.parse(raw)
  assert(['smoke-model', 'other-smoke-model'].includes(body.model))
  const dump = JSON.stringify(body.messages)
  seen.push(dump)
  const user = body.messages.find(message => message.role === 'user')?.content ?? ''
  if (user.includes('PRIMARY NATIVE SMOKE')) {
    const hasObservation = dump.includes('NATIVE_SHELL_READ_91c73')
    answer(res, hasObservation ? completion('native first run completed') : tool('cat probe.txt'))
  } else if (user.includes('CANCEL NATIVE SMOKE')) {
    answer(res, tool('sleep 30'))
  } else if (user.includes('RECOVER NATIVE SMOKE')) {
    answer(res, completion('native cancellation recovery completed'))
  } else if (user.includes('FAILURE NATIVE SMOKE')) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'local provider failure' } }))
  } else if (user.includes('FOLLOWUP NATIVE SMOKE')) {
    assert(dump.includes('NATIVE_SHELL_READ_91c73'), 'same conversation history must reach the model')
    answer(res, completion('history resumed'))
  } else if (user.includes('ISOLATION NATIVE SMOKE')) {
    assert(!dump.includes('NATIVE_SHELL_READ_91c73'), 'different profile must not inherit conversation history')
    answer(res, completion('isolated route completed'))
  } else {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unexpected smoke task: ${user.slice(0, 120)}` } }))
  }
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}/v1`
const profile = { id: 'local-smoke', provider: 'openai', model: 'smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'MINI_SWE_SMOKE_KEY', baseUrl }
const env = { ...process.env, MINI_SWE_SMOKE_KEY: 'local-mini-swe-smoke-key', OPENAI_API_KEY: 'wrong-ambient-secret', MSWEA_MODEL_NAME: 'wrong-environment-model', MSWEA_GLOBAL_CONFIG_DIR: join(state, 'poison-config') }
await mkdir(env.MSWEA_GLOBAL_CONFIG_DIR)
await writeFile(join(env.MSWEA_GLOBAL_CONFIG_DIR, 'mini.yaml'), 'model_name: fake/model\n')
const runtimeState = resolve(root, '.talent')
const sessionId = `native-${randomUUID()}`
const pkg = await createAgentPackage({ workspace, stateDir: runtimeState, env, config: { python: join(runtimeState, 'mini-swe-agent/venv/bin/python'), stepLimit: 5, commandTimeoutSeconds: 40, cancelGraceMs: 3000 } })
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
try {
  const primary = await collect(pkg.executeTask({ taskId: 'primary', sessionId, input: 'PRIMARY NATIVE SMOKE', model: profile }))
  assert(primary.some(event => event.type === 'tool-call' && event.input === 'cat probe.txt'))
  assert(primary.some(event => event.type === 'tool-result' && event.output.includes('NATIVE_SHELL_READ_91c73')))
  assert(primary.at(-1).type === 'assistant-complete')
  assert(seen.some(messages => messages.includes('NATIVE_SHELL_READ_91c73')))

  const follow = await collect(pkg.executeTask({ taskId: 'follow', sessionId, input: 'FOLLOWUP NATIVE SMOKE', model: profile }))
  assert.equal(follow.at(-1).type, 'assistant-complete')
  const isolated = await collect(pkg.executeTask({ taskId: 'isolated', sessionId, input: 'ISOLATION NATIVE SMOKE', model: { ...profile, id: 'local-isolated', model: 'other-smoke-model' } }))
  assert.equal(isolated.at(-1).type, 'assistant-complete')

  const cancelStream = pkg.executeTask({ taskId: 'cancel', sessionId, input: 'CANCEL NATIVE SMOKE', model: profile })
  const cancelEvents = []
  let toolSeenResolve
  const toolSeen = new Promise(resolveSeen => { toolSeenResolve = resolveSeen })
  const reader = (async () => { for await (const event of cancelStream) { cancelEvents.push(event); if (event.type === 'tool-call') toolSeenResolve() } })()
  await Promise.race([toolSeen, new Promise((_, reject) => setTimeout(() => reject(new Error('native sleep command did not start')), 15000))])
  await pkg.cancelTask('cancel')
  await reader
  assert(cancelEvents.some(event => event.type === 'cancelled'))
  const recovered = await collect(pkg.executeTask({ taskId: 'recover', sessionId, input: 'RECOVER NATIVE SMOKE', model: profile }))
  assert.equal(recovered.at(-1).type, 'assistant-complete')

  const failed = await collect(pkg.executeTask({ taskId: 'failure', sessionId: 'failure-session', input: 'FAILURE NATIVE SMOKE', model: { ...profile, id: 'local-failing', baseUrl: `http://127.0.0.1:${port}/fail/v1` } }))
  assert(failed.some(event => event.type === 'error'))
  assert(keyChecks >= 1)
  const stored = await walk(state)
  for (const file of stored) {
    if (file.endsWith('.json')) assert(!(await readFile(file, 'utf8')).includes('local-mini-swe-smoke-key'), `credential written to ${file}`)
  }
  console.log('mini-SWE-agent 2.4.6 native runtime smoke passed: LocalEnvironment bash result -> model, session history, model-profile isolation, scoped cancel/recovery, provider failure, credential persistence scan')
} finally {
  await pkg.dispose()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(state, { recursive: true, force: true })
}

function tool(command) { return { id: `call-${Math.random().toString(16).slice(2)}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } } }
function answer(res, item) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: 'smoke-model', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [item] } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }))
}
function completion(text) { return tool(`printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\n${text}'`) }
async function walk(dir) { const found = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) found.push(...await walk(path)); else found.push(path) } return found }
