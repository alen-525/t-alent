import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentPackage } from '../src/index.mjs'

const repo = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const stateDir = process.env.TALENT_STATE_DIR ?? resolve(repo, '.talent/magentic-one')
const python = process.env.TALENT_MAGENTIC_ONE_PYTHON ?? resolve(stateDir, 'magentic-one-runtime/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const testRoot = await mkdtemp(join(tmpdir(), 'talent-magentic-one-real-'))
const workspace = join(testRoot, 'workspace')
const otherWorkspace = join(testRoot, 'workspace-other')
await mkdir(workspace); await mkdir(otherWorkspace)
await writeFile(join(workspace, 'probe.txt'), 'MAGENTIC_PROBE_MARKER_9c11')
await writeFile(join(otherWorkspace, 'probe.txt'), 'MAGENTIC_OTHER_WORKSPACE_c233')
const requests = []
let cancelReadyResolve
const cancelReady = new Promise(resolveReady => { cancelReadyResolve = resolveReady })
const progressCalls = new Map()
const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404); res.end(); return
  }
  assert.equal(req.headers.authorization, 'Bearer magentic-local-secret')
  const body = JSON.parse(raw)
  requests.push(body)
  const messages = body.messages ?? []
  const joined = messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
  const taskMarkers = ['MAGENTIC_PRIMARY_TASK', 'MAGENTIC_FOLLOWUP_TASK', 'MAGENTIC_PROFILE_TASK', 'MAGENTIC_WORKSPACE_TASK', 'MAGENTIC_CANCEL_TASK', 'MAGENTIC_RECOVERY_TASK', 'MAGENTIC_FAILURE_TASK', 'MAGENTIC_LIMIT_TASK']
  const latestTask = taskMarkers.map(marker => ({ marker, index: joined.lastIndexOf(marker) })).sort((a, b) => b.index - a.index)[0]?.marker
  if (body.model === 'magentic-failure-model') {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock unauthorized' } })); return
  }
  let content
  if (latestTask === 'MAGENTIC_CANCEL_TASK' && joined.includes('pre-survey')) {
    cancelReadyResolve()
    await new Promise(resolveDelay => {
      const timer = setTimeout(resolveDelay, 30_000)
      res.on('close', () => { clearTimeout(timer); resolveDelay() })
    })
    if (res.destroyed) return
  }
  if (joined.includes('pre-survey')) {
    content = 'No outside facts are needed. The task can be completed using the local workspace.'
  } else if (joined.includes('devise a short bullet-point plan')) {
    content = '1. Ask Coder to inspect and implement the requested workspace change.\n2. Use ComputerTerminal to execute and verify it.'
  } else if (joined.includes('pure JSON format') && joined.includes('is_request_satisfied')) {
    const number = (progressCalls.get(latestTask) ?? 0) + 1
    progressCalls.set(latestTask, number)
    if (latestTask === 'MAGENTIC_LIMIT_TASK') {
      content = ledger(false, 'Coder', 'Make a tiny local code observation; do not claim the task is complete.')
    } else if (latestTask === 'MAGENTIC_PRIMARY_TASK' && number === 1) {
      content = ledger(false, 'Coder', 'Inspect probe.txt, write created.txt with MAGENTIC_WRITE_RESULT_4a12, and print both values.')
    } else if (latestTask === 'MAGENTIC_PRIMARY_TASK' && number === 2) {
      content = ledger(false, 'ComputerTerminal', 'Execute the Python code proposed by Coder in the workspace.')
    } else if (latestTask === 'MAGENTIC_PRIMARY_TASK' && number === 3) {
      assert(joined.includes('MAGENTIC_WRITE_RESULT_4a12'), 'native executor output should be present in the orchestrator context')
      content = ledger(true, 'Coder', 'The local code ran successfully and created the requested file.')
    } else {
      content = ledger(true, 'Coder', 'The requested smoke task is complete.')
    }
  } else if (joined.includes('We have completed the task.')) {
    content = 'Verified completion.'
  } else if (messages.some(message => message.role === 'system' && String(message.content).includes('helpful AI assistant'))) {
    if (latestTask === 'MAGENTIC_LIMIT_TASK') content = '```python\nprint("Magentic max-turn probe")\n```'
    else {
      assert.equal(latestTask, 'MAGENTIC_PRIMARY_TASK')
      content = '```python\nfrom pathlib import Path\nprobe = Path("probe.txt").read_text()\nPath("created.txt").write_text("MAGENTIC_WRITE_RESULT_4a12")\nprint(probe)\nprint(Path("created.txt").read_text())\n```'
    }
  } else {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unhandled mock model request for ${latestTask}: ${joined.slice(-800)}` } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'chatcmpl-magentic-local', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const profile = { id: 'local', name: 'Magentic test', provider: 'arbitrary-label', model: 'magentic-smoke-model', protocol: 'openai-chat-completions', apiKeyEnv: 'MAGENTIC_LOCAL_KEY', baseUrl }
const env = { ...process.env, MAGENTIC_LOCAL_KEY: 'magentic-local-secret', OPENAI_API_KEY: 'wrong-ambient-key', CUSTOM_CREDENTIAL: 'ambient-value' }
const config = { python, maxTurns: 8, cancelGraceMs: 2000 }
const agent = await createAgentPackage({ workspace, stateDir, env, config })
const otherAgent = await createAgentPackage({ workspace: otherWorkspace, stateDir, env, config })
const limitAgent = await createAgentPackage({ workspace, stateDir, env, config: { python, maxTurns: 1, cancelGraceMs: 2000 } })
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
const sessionId = 'magentic-native-session'
try {
  const primary = await collect(agent.executeTask({ taskId: 'primary', sessionId, input: 'MAGENTIC_PRIMARY_TASK read probe.txt and write the output marker.', model: profile }))
  assert(primary.some(event => event.type === 'harness-event' && /Coder|MagenticOneOrchestrator/.test(event.event.agent)))
  assert(primary.some(event => event.type === 'harness-event' && /ComputerTerminal/.test(event.event.agent)))
  assert.equal(primary.at(-1).type, 'assistant-complete')
  assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'MAGENTIC_WRITE_RESULT_4a12')
  assert(requests.some(request => JSON.stringify(request.messages).includes('MAGENTIC_PROBE_MARKER_9c11')), 'native executor observation should return to the orchestrator model')
  const stateFiles = await walk(stateDir)
  const stateFile = stateFiles.find(path => path.endsWith('team-state.json'))
  assert(stateFile, 'native team state should be persisted')
  const savedState = JSON.parse(await readFile(stateFile, 'utf8'))
  const managerState = Object.values(savedState.agent_states).find(value => Array.isArray(value.message_thread))
  assert(managerState?.message_thread?.length > 0, 'native Magentic-One message history should be saved')

  const followup = await collect(agent.executeTask({ taskId: 'followup', sessionId, input: 'MAGENTIC_FOLLOWUP_TASK continue after native state restore.', model: profile }))
  assert.equal(followup.at(-1).type, 'assistant-complete')
  const profileOnly = await collect(agent.executeTask({ taskId: 'profile', sessionId, input: 'MAGENTIC_PROFILE_TASK isolate another model profile.', model: { ...profile, id: 'second', model: 'magentic-profile-model' } }))
  assert.equal(profileOnly.at(-1).type, 'assistant-complete')
  const workspaceOnly = await collect(otherAgent.executeTask({ taskId: 'workspace', sessionId, input: 'MAGENTIC_WORKSPACE_TASK verify another workspace.', model: profile }))
  assert.equal(workspaceOnly.at(-1).type, 'assistant-complete')

  const cancelStream = collect(agent.executeTask({ taskId: 'cancel', sessionId, input: 'MAGENTIC_CANCEL_TASK wait during model request.', model: profile }))
  await withTimeout(cancelReady, 15_000, 'cancel task did not reach localhost model')
  await agent.cancelTask('cancel')
  assert.equal((await cancelStream).at(-1).type, 'cancelled')
  const recovered = await collect(agent.executeTask({ taskId: 'recovery', sessionId, input: 'MAGENTIC_RECOVERY_TASK run after cancellation.', model: profile }))
  assert.equal(recovered.at(-1).type, 'assistant-complete')
  const failed = await collect(agent.executeTask({ taskId: 'failure', sessionId, input: 'MAGENTIC_FAILURE_TASK verify provider errors.', model: { ...profile, id: 'failure', model: 'magentic-failure-model' } }))
  assert(failed.some(event => event.type === 'error'))
  const stateCountBeforeLimit = (await walk(stateDir)).filter(path => path.endsWith('team-state.json')).length
  const limited = await collect(limitAgent.executeTask({ taskId: 'limit', sessionId, input: 'MAGENTIC_LIMIT_TASK test native max-turn handling.', model: { ...profile, id: 'limit', model: 'magentic-limit-model' } }))
  assert(limited.some(event => event.type === 'error' && /max-turn limit/.test(event.message)), 'native Max rounds reached must fail instead of reporting success')
  assert.equal((await walk(stateDir)).filter(path => path.endsWith('team-state.json')).length, stateCountBeforeLimit, 'max-turn-limited state must not be persisted as completed history')

  for (const path of await walk(stateDir)) if (path.endsWith('.json')) assert(!(await readFile(path, 'utf8')).includes('magentic-local-secret'), `credential persisted in ${path}`)
  assert.equal(JSON.stringify(requests).includes('magentic-local-secret'), false)
  assert(requests.some(request => request.model === 'magentic-profile-model'))
  assert(requests.some(request => request.model === 'magentic-smoke-model'))
  console.log('AutoGen 0.7.5 native MagenticOneGroupChat smoke passed: Coder -> ComputerTerminal, workspace read/write, tool observations, native save/load state, profile/workspace isolation, cancellation/recovery, 401, max-turn failure, credential scan')
} finally {
  await agent.dispose(); await otherAgent.dispose(); await limitAgent.dispose()
  await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections?.(); server.closeAllConnections?.() })
  await rm(testRoot, { recursive: true, force: true })
}

function ledger(satisfied, speaker, instruction) {
  const bool = (answer, reason) => ({ answer, reason })
  const text = (answer, reason) => ({ answer, reason })
  return JSON.stringify({ is_request_satisfied: bool(satisfied, satisfied ? 'The workspace task completed.' : 'The requested operation still needs to run.'), is_in_loop: bool(false, 'No repeated actions.'), is_progress_being_made: bool(true, 'The team is making progress.'), next_speaker: text(speaker, 'The selected agent can make the next step.'), instruction_or_question: text(instruction, 'This is the next required action.') })
}
async function withTimeout(promise, ms, message) {
  let timer
  try {
    await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally { clearTimeout(timer) }
}
async function walk(dir) {
  const rows = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) rows.push(...await walk(path)); else rows.push(path)
  }
  return rows
}
