import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const repo = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const baseState = process.env.TALENT_STATE_DIR ?? resolve(repo, '.talent')
const python = process.env.TALENT_SMOLAGENTS_PYTHON ?? resolve(baseState, 'smolagents/smolagents-runtime/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const testRoot = await mkdtemp(join(tmpdir(), 'talent-smolagents-real-'))
const stateDir = join(testRoot, 'state')
const workspace = join(testRoot, 'workspace')
const secondWorkspace = join(testRoot, 'workspace-two')
await mkdir(workspace); await mkdir(secondWorkspace)
await writeFile(join(workspace, 'probe.txt'), 'SMOLAGENTS_PROBE_MARKER_8f2c')
await writeFile(join(secondWorkspace, 'probe.txt'), 'SMOLAGENTS_OTHER_WORKSPACE_21bd')
const modelRequests = []
let cancelStarted
const cancelReady = new Promise(resolveReady => { cancelStarted = resolveReady })
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer smolagents-local-secret')
  const body = JSON.parse(raw)
  modelRequests.push(body)
  const joined = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  const taskMarkers = [
    'PRIMARY SMOLAGENTS NATIVE SMOKE', 'FOLLOWUP SMOLAGENTS NATIVE SMOKE',
    'ISOLATION SMOLAGENTS PROFILE', 'ISOLATION SMOLAGENTS WORKSPACE',
    'CANCEL SMOLAGENTS NATIVE SMOKE', 'RECOVER SMOLAGENTS NATIVE SMOKE',
    'PROVIDER FAILURE SMOLAGENTS',
  ]
  const latestTask = taskMarkers.map(marker => ({ marker, index: joined.lastIndexOf(marker) })).sort((a, b) => b.index - a.index)[0]?.marker
  if (body.model === 'smolagents-failure-model') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'mock unauthorized' } }))
    return
  }
  let code
  if (latestTask === 'PRIMARY SMOLAGENTS NATIVE SMOKE') {
    code = joined.includes('SMOLAGENTS_PROBE_MARKER_8f2c') && joined.includes('SMOLAGENTS_WRITE_MARKER_37a1')
      ? '<code>final_answer("PRIMARY_SMOLAGENTS_DONE")</code>'
      : '<code>contents = read_file("probe.txt")\nwrite_file("created.txt", "SMOLAGENTS_WRITE_MARKER_37a1")\nprint(contents)\nprint(read_file("created.txt"))</code>'
  } else if (latestTask === 'FOLLOWUP SMOLAGENTS NATIVE SMOKE') {
    assert(joined.includes('PRIMARY SMOLAGENTS NATIVE SMOKE'), 'native CodeAgent context should contain the earlier task')
    assert(joined.includes('SMOLAGENTS_PROBE_MARKER_8f2c'), 'native CodeAgent context should contain the earlier workspace observation')
    code = '<code>final_answer("FOLLOWUP_SMOLAGENTS_DONE")</code>'
  } else if (latestTask === 'ISOLATION SMOLAGENTS PROFILE') {
    assert(!joined.includes('PRIMARY SMOLAGENTS NATIVE SMOKE'), 'different profile should have isolated native history')
    code = '<code>final_answer("PROFILE_ISOLATION_OK")</code>'
  } else if (latestTask === 'ISOLATION SMOLAGENTS WORKSPACE') {
    assert(!joined.includes('PRIMARY SMOLAGENTS NATIVE SMOKE'), 'different workspace should have isolated native history')
    if (joined.includes('SMOLAGENTS_OTHER_WORKSPACE_21bd')) {
      code = '<code>final_answer("WORKSPACE_ISOLATION_OK")</code>'
    } else {
      code = '<code>print(read_file("probe.txt"))</code>'
    }
  } else if (latestTask === 'CANCEL SMOLAGENTS NATIVE SMOKE') {
    cancelStarted()
    code = '<code>while True:\n    pass</code>'
  } else if (latestTask === 'RECOVER SMOLAGENTS NATIVE SMOKE') {
    code = '<code>final_answer("RECOVERY_OK")</code>'
  } else {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unexpected task ${joined.slice(0, 140)}` } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    id: 'chatcmpl-smolagents-local', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: code } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }))
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}/v1`
const profile = { id: 'smolagents-local', name: 'Display label', provider: 'local-compatible', model: 'smolagents-smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'SMOLAGENTS_LOCAL_KEY', baseUrl }
const env = { ...process.env, SMOLAGENTS_LOCAL_KEY: 'smolagents-local-secret', OPENAI_API_KEY: 'wrong-ambient-key', SMOLAGENTS_UNRELATED_TOKEN: 'ambient-token' }
const config = { python, maxSteps: 8, cancelGraceMs: 1500 }
const mainAgent = await createAgentPackage({ workspace, stateDir, env, config })
const otherWorkspaceAgent = await createAgentPackage({ workspace: secondWorkspace, stateDir, env, config })
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
const sessionId = 'smolagents-native-session'
try {
  const primary = await collect(mainAgent.executeTask({ taskId: 'primary', sessionId, input: 'PRIMARY SMOLAGENTS NATIVE SMOKE', model: profile }))
  assert(primary.some(event => event.type === 'tool-call' && event.input.includes('read_file')))
  assert(primary.some(event => event.type === 'tool-result' && event.output.includes('SMOLAGENTS_PROBE_MARKER_8f2c')))
  assert.equal(primary.at(-1).type, 'assistant-complete')
  assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'SMOLAGENTS_WRITE_MARKER_37a1')
  assert(modelRequests.some(body => JSON.stringify(body.messages).includes('SMOLAGENTS_WRITE_MARKER_37a1')), 'Python observations should return to the next native model call')

  const followup = await collect(mainAgent.executeTask({ taskId: 'followup', sessionId, input: 'FOLLOWUP SMOLAGENTS NATIVE SMOKE', model: profile }))
  assert.equal(followup.at(-1).type, 'assistant-complete')
  const profileIsolated = await collect(mainAgent.executeTask({ taskId: 'profile-isolated', sessionId, input: 'ISOLATION SMOLAGENTS PROFILE', model: { ...profile, id: 'other-profile', model: 'other-smolagents-model' } }))
  assert.equal(profileIsolated.at(-1).type, 'assistant-complete')
  const workspaceIsolated = await collect(otherWorkspaceAgent.executeTask({ taskId: 'workspace-isolated', sessionId, input: 'ISOLATION SMOLAGENTS WORKSPACE', model: profile }))
  assert.equal(workspaceIsolated.at(-1).type, 'assistant-complete')

  const cancelStream = mainAgent.executeTask({ taskId: 'cancel', sessionId, input: 'CANCEL SMOLAGENTS NATIVE SMOKE', model: profile })
  const cancelReader = collect(cancelStream)
  await Promise.race([cancelReady, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel task did not reach local model')), 15000))])
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  await mainAgent.cancelTask('cancel')
  assert.equal((await cancelReader).at(-1).type, 'cancelled')
  const recovered = await collect(mainAgent.executeTask({ taskId: 'recovery', sessionId, input: 'RECOVER SMOLAGENTS NATIVE SMOKE', model: profile }))
  assert.equal(recovered.at(-1).type, 'assistant-complete')

  const failure = await collect(mainAgent.executeTask({ taskId: 'failure', sessionId, input: 'PROVIDER FAILURE SMOLAGENTS', model: { ...profile, id: 'failure-profile', model: 'smolagents-failure-model' } }))
  assert(failure.some(event => event.type === 'error'))
  for (const file of await walk(stateDir)) if (file.endsWith('.json')) assert(!(await readFile(file, 'utf8')).includes('smolagents-local-secret'), `credential persisted in ${file}`)
  assert.equal(JSON.stringify(modelRequests).includes('smolagents-local-secret'), false)
  console.log('smolagents 1.26.0 native CodeAgent/LocalPythonExecutor smoke passed: workspace read/write, observation -> next model request, native RunResult.steps history, profile/workspace isolation, cancel/recovery, provider failure, credential scan')
} finally {
  await mainAgent.dispose()
  await otherWorkspaceAgent.dispose()
  await new Promise(resolveClose => {
    server.close(resolveClose)
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
  })
  await rm(testRoot, { recursive: true, force: true })
}

async function walk(dir) {
  const rows = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) rows.push(...await walk(path))
    else rows.push(path)
  }
  return rows
}
