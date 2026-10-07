import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { makeTerminal } from './terminal.mjs'
import { getAgentIdentity } from './agent-identity.mjs'

const STORE_VERSION = 1

function short(value, max = 180) {
  const clean = stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
function packageId(row) { return row?.manifest?.id }
function packageName(row) { return row?.manifest?.name || packageId(row) || 'unknown' }
function modelName(model) { return model?.name || model?.id || 'unknown' }
function parseCommand(line) {
  const match = line.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  return match ? { name: match[1].toLowerCase(), arg: (match[2] || '').trim() } : null
}
function formatDuration(ms) {
  const sec = Math.floor(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

async function loadStore(dir) {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'sessions.json')
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data?.version === STORE_VERSION && Array.isArray(data.sessions) && Array.isArray(data.history)) return { file, sessions: data.sessions.filter(validSession), history: data.history.filter(x => typeof x === 'string').slice(0, 100) }
    throw new Error('Invalid CLI session store format.')
  } catch (err) { if (err?.code !== 'ENOENT') throw new Error(`Cannot read CLI session store: ${short(err?.message || err)}`) }
  return { file, sessions: [], history: [] }
}
function validSession(s) {
  return Boolean(s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.packageId === 'string' && typeof s.modelId === 'string' && Number.isFinite(s.updatedAt))
}
async function saveStore(store) {
  const write = async () => {
    const tmp = `${store.file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ version: STORE_VERSION, sessions: store.sessions, history: store.history }, null, 2), { mode: 0o600 })
    await rename(tmp, store.file)
  }
  store.writeQueue = (store.writeQueue || Promise.resolve()).catch(() => {}).then(write)
  return store.writeQueue
}

export async function runCli({ client, options = {}, input = process.stdin, output = process.stdout, error = process.stderr }) {
  const term = makeTerminal({ input, output, color: options.color })
  const packages = (client.packages || []).filter(row => row?.manifest?.id && row.runtimeReady === true)
  const models = client.models || []
  const interactiveTasks = term.tty && !options.exec && !options.json
  let selectedPackageId = options.harness || ''
  let selectedModelId = options.model || client.defaultModelId || ''
  let activeSession = null
  let busy = null
  let stopping = false
  let signalExitCode = 0
  const inputAbort = new AbortController()
  const store = await loadStore(path.join(options.stateDir || path.join(options.workspace || client.workspace || process.cwd(), '.talent'), 'cli'))
  const packageFor = id => packages.find(row => packageId(row) === id)
  const modelFor = id => models.find(model => model.id === id)
  const identityFor = id => getAgentIdentity(packageFor(id)?.manifest)
  const activeIdentity = () => identityFor(selectedPackageId)
  const promptPrefix = () => `${activeIdentity().mark || '✳'} › `
  const workspaceName = () => short(client.workspace || options.workspace || process.cwd())
  const displayModel = () => selectedModelId ? modelName(modelFor(selectedModelId)) : 'Choose with /model'
  const displayHarness = () => `${activeIdentity().mark || '✳'} ${selectedPackageId ? packageName(packageFor(selectedPackageId) || { manifest: { id: selectedPackageId } }) : activeIdentity().label}`
  const drawBrand = (compact = false) => term.brand({
    identity: activeIdentity(),
    title: `t-alent CLI · v${options.version || '0.2.0'}`,
    compact,
    rows: [`model     ${displayModel()}`, `harness   ${displayHarness()}`, `directory ${workspaceName()}`],
  })
  const packageCompatible = (pkg, model) => pkg?.manifest?.modelProtocols === undefined || pkg.manifest.modelProtocols.includes(model?.protocol)
  const sessionCompatible = (session, pkg, model) => Boolean(pkg && model && packageCompatible(pkg, model)
    && (!session.workspace || path.resolve(session.workspace) === path.resolve(client.workspace || options.workspace || process.cwd()))
    && (!session.packageVersion || session.packageVersion === pkg.manifest.version)
    && (!session.sourceVersion || session.sourceVersion === pkg.manifest.source?.version)
    && (!session.programFingerprint || session.programFingerprint === pkg.compilation?.fingerprint))
  const reportError = message => {
    if (options.json) output.write(`${JSON.stringify({ type: 'error', message })}\n`)
    else if (options.exec) error.write(`${message}\n`)
    else term.line(term.colorize(message, '\u001b[31m'))
  }
  const pick = async (kind, items, title, current) => {
    if (!items.length) { term.line(term.colorize(`No ${kind}s are available.`, '\u001b[33m')); return null }
    if (!term.tty) { term.line(`${title}: ${items.map(x => x.label).join(', ')}`); return null }
    const result = await term.readLine({ history: store.history, select: { title: `${activeIdentity().mark || '✳'} ${title}`, items: items.map(x => x.label), index: Math.max(0, items.findIndex(x => x.id === current)) }, signal: inputAbort.signal, prefix: promptPrefix() })
    await persistHistory(result.history)
    return result.cancelled ? null : items[result.selected]
  }
  const persistHistory = async history => { store.history = history || store.history; await saveStore(store) }
  const makeSession = async () => {
    if (!selectedPackageId || !selectedModelId) return null
    const pkg = packageFor(selectedPackageId)
    const s = { id: randomUUID(), title: 'New session', packageId: selectedPackageId, packageVersion: pkg?.manifest.version, sourceVersion: pkg?.manifest.source?.version, programFingerprint: pkg?.compilation?.fingerprint, modelId: selectedModelId, workspace: path.resolve(client.workspace || options.workspace || process.cwd()), createdAt: Date.now(), updatedAt: Date.now() }
    store.sessions.unshift(s)
    activeSession = s
    await saveStore(store)
    return s
  }
  const persistSession = async () => { if (activeSession) { activeSession.updatedAt = Date.now(); await saveStore(store) } }
  const setPackage = async id => {
    const pkg = packageFor(id)
    if (!pkg) { term.line(term.colorize(`Unknown or unavailable harness: ${short(id)}`, '\u001b[31m')); return false }
    selectedPackageId = id; activeSession = null; await makeSession()
    if (interactiveTasks) drawBrand(true)
    term.line(`Harness set to ${term.colorize(packageName(pkg), '\u001b[36m')} (${short(id)})`)
    return true
  }
  const setModel = async id => {
    const model = modelFor(id)
    if (!model) { term.line(term.colorize(`Unknown model: ${short(id)}`, '\u001b[31m')); return false }
    selectedModelId = id; activeSession = null; await makeSession()
    if (interactiveTasks) drawBrand(true)
    term.line(`Model set to ${term.colorize(modelName(model), '\u001b[36m')} (${short(id)})`)
    return true
  }

  const startTask = async taskInput => {
    if (busy) { reportError('A task is already running.'); return { ok: false } }
    const pkg = packageFor(selectedPackageId), model = modelFor(selectedModelId)
    if (!pkg) { reportError('Choose a harness first with /harness.'); return { ok: false } }
    if (!model) { reportError('Choose a model first with /model.'); return { ok: false } }
    if (!packageCompatible(pkg, model)) { reportError('The selected harness does not support the selected model.'); return { ok: false } }
    if (!activeSession || activeSession.packageId !== selectedPackageId || activeSession.modelId !== selectedModelId) await makeSession()
    if (activeSession.title === 'New session') activeSession.title = short(taskInput.replace(/\s+/g, ' '), 72) || 'New session'
    const taskId = randomUUID(), sessionId = activeSession.id, started = Date.now()
    const state = { taskId, cancelled: false, text: '', segments: [], error: null, cancelPromise: null }
    busy = state
    const priorRaw = input.isRaw
    if (interactiveTasks) input.resume?.()
    if (interactiveTasks) readline.emitKeypressEvents(input)
    if (interactiveTasks && typeof input.setRawMode === 'function') input.setRawMode(true)
    const onBusyKey = (_str, key = {}) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) void cancelBusy()
    }
    const onBusyEnd = () => void cancelBusy()
    if (interactiveTasks) input.on('keypress', onBusyKey)
    if (interactiveTasks) input.once('end', onBusyEnd)
    const taskMark = identityFor(selectedPackageId).mark || '✳'
    const progressTimer = interactiveTasks ? setInterval(() => term.status(`${taskMark} Working · ${formatDuration(Date.now() - started)} · ${modelName(model)} · Esc to cancel`), 1000) : null
    if (interactiveTasks) term.line(term.colorize(`${taskMark} ${packageName(pkg)} · ${modelName(model)}`, '\u001b[90m'))
    let iterator
    try {
      iterator = client.executeTask({ taskId, sessionId, packageId: selectedPackageId, modelId: selectedModelId, input: taskInput })[Symbol.asyncIterator]()
      while (true) {
        const item = await iterator.next()
        if (item.done) break
        const event = item.value || {}
        if (event.type === 'assistant-delta') {
          state.text += String(event.text ?? '')
          if (interactiveTasks) term.replaceCurrent(state.text)
        } else if (event.type === 'assistant-replace') {
          state.text = String(event.text ?? '')
          if (interactiveTasks) term.replaceCurrent(state.text)
        } else if (event.type === 'assistant-complete') {
          const completedText = state.text
          if (completedText) state.segments.push(completedText)
          state.text = ''
          if (interactiveTasks) { term.replaceCurrent(completedText); term.commitCurrent() }
        }
        else if (event.type === 'tool-call') {
          if (interactiveTasks) {
            term.clearCurrent()
            const inputSummary = event.input && typeof event.input === 'object' ? ['cmd', 'command', 'path', 'file_path'].filter(key => typeof event.input[key] === 'string').map(key => event.input[key]).join(' · ') : ''
            term.line(term.colorize(`• ${short(event.name, 80)}${inputSummary ? ` · ${short(inputSummary, 140)}` : ''}`, '\u001b[90m'))
          }
        } else if (event.type === 'tool-result') {
          if (interactiveTasks) {
            term.clearCurrent()
            const outcome = event.status === 'error' ? 'failed' : event.status === 'unknown' ? 'result' : 'completed'
            term.line(term.colorize(`• ${short(event.name || 'native tool', 80)} ${outcome}`, '\u001b[90m'))
            if (event.output !== undefined) {
              const rows = String(event.output).split(/\r?\n/).slice(0, 3)
              rows.forEach(row => term.line(term.colorize(`  └ ${short(row, Math.max(16, term.width() - 8))}`, '\u001b[90m')))
              if (String(event.output).split(/\r?\n/).length > rows.length) term.line(term.colorize('  └ …', '\u001b[90m'))
            }
          }
        } else if (event.type === 'harness-event' && typeof event.event?.agent === 'string' && typeof event.event?.content === 'string') {
          if (interactiveTasks) {
            term.clearCurrent()
            term.line(term.colorize(`• ${short(event.event.agent, 80)} · ${short(event.event.content, 180)}`, '\u001b[90m'))
          }
        } else if (event.type === 'error') state.error = short(event.message, 2000) || 'Task failed.'
        else if (event.type === 'cancelled') state.cancelled = true
        else if (event.type === 'session' && typeof event.sessionId === 'string') { /* UI session IDs are locally owned. */ }
        if (options.json) output.write(`${JSON.stringify(event)}\n`)
      }
    } catch (err) {
      state.error = short(err?.message || err, 2000)
      if (options.json) output.write(`${JSON.stringify({ type: 'error', message: state.error })}\n`)
    }
    finally {
      if (progressTimer) clearInterval(progressTimer)
      if (interactiveTasks) input.off('keypress', onBusyKey)
      if (interactiveTasks) input.off('end', onBusyEnd)
      if (interactiveTasks && typeof input.setRawMode === 'function') input.setRawMode(Boolean(priorRaw))
      if (busy === state) busy = null
      if (state.text) state.segments.push(state.text)
      if (interactiveTasks) { term.replaceCurrent(state.text); term.status(''); term.commitCurrent(); term.clearLine() }
      await persistSession()
    }
    if (options.json) return { ok: !state.error && !state.cancelled, state }
    const finalText = state.segments.join('\n')
    if (finalText && !interactiveTasks) output.write(`${term.safe(finalText)}${finalText.endsWith('\n') ? '' : '\n'}`)
    else if (finalText && interactiveTasks) term.line('')
    if (state.error) { error.write(`${state.error}\n`); if (interactiveTasks) term.line(term.colorize(`• Error · ${state.error}`, '\u001b[31m')) }
    if (state.cancelled) { if (interactiveTasks) term.line(term.colorize('• Cancelled', '\u001b[90m')) }
    return { ok: !state.error && !state.cancelled, state }
  }

  const cancelBusy = async () => {
    const state = busy
    if (!state || state.cancelPromise) return
    state.cancelled = true
    state.cancelPromise = Promise.resolve().then(() => client.cancelTask(state.taskId)).catch(err => { state.error ||= short(err?.message || err, 500) })
    await state.cancelPromise
  }
  const onSignal = code => { signalExitCode = code; stopping = true; inputAbort.abort(); void cancelBusy() }
  const onSigterm = () => onSignal(143)
  const onSigint = () => onSignal(130)
  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)
  const cleanup = () => { process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigint) }
  try {
    if (options.resume) {
      const found = store.sessions.find(s => s.id === options.resume)
      if (!found) { error.write(`No local session with ID ${short(options.resume)}.\n`); return 1 }
      const pkg = packageFor(found.packageId), model = modelFor(found.modelId)
      if (!sessionCompatible(found, pkg, model)) { error.write(`Session ${found.id} cannot be resumed: its workspace, harness version, compiled program, or model is missing or incompatible.\n`); return 1 }
      activeSession = found; selectedPackageId = found.packageId; selectedModelId = found.modelId
    }
    if (options.exec) {
      const prompt = options.prompt
      if (!prompt?.trim()) { error.write('--exec requires a prompt.\n'); return 2 }
      const result = await startTask(prompt)
      return signalExitCode || (result.ok ? 0 : 1)
    }
    if (!term.tty) {
      error.write('Interactive mode requires a TTY. Use --exec with a prompt for a one-shot task.\n')
      return 2
    }

    drawBrand()
    term.line(term.colorize(`${promptPrefix()}prompt     ? for shortcuts`, '\u001b[90m'))
    if (!packages.length) term.line(term.colorize('No runnable harnesses are installed. /help remains available.', '\u001b[90m'))
    if (!models.length) term.line(term.colorize('No models are configured. Add a model profile before running tasks.', '\u001b[90m'))
    if (options.prompt?.trim()) await startTask(options.prompt)

    while (!stopping) {
      if (busy) { await new Promise(resolve => setTimeout(resolve, 30)); continue }
      const result = await term.readLine({ history: store.history, onInterrupt: () => { signalExitCode = 130; stopping = true; inputAbort.abort() }, signal: inputAbort.signal, prefix: promptPrefix() })
      await persistHistory(result.history)
      if (result.interrupted) break
      const text = result.value.trim()
      if (!text) continue
      const cmd = text === '?' ? { name: '?', arg: '' } : parseCommand(text)
      if (!cmd) { await startTask(text); continue }
      if (cmd.name === 'help' || cmd.name === '?') {
        term.line('Commands: /harness [id]  /model [id]  /new  /status  /clear  /resume [id]  /quit')
        term.line('Use ↑/↓ to choose an item. Ctrl+J inserts a newline. Tab completes slash commands.')
      } else if (cmd.name === 'harness') {
        if (cmd.arg) await setPackage(cmd.arg)
        else {
          const items = packages.map(row => ({ id: packageId(row), label: `${getAgentIdentity(row.manifest).mark || '✳'} ${packageName(row)} · ${packageId(row)}` }))
          const chosen = await pick('harness', items, 'Select harness', selectedPackageId)
          if (chosen) await setPackage(chosen.id)
        }
      } else if (cmd.name === 'model') {
        const eligible = models
        if (cmd.arg) await setModel(cmd.arg)
        else {
          const items = eligible.map(m => ({ id: m.id, label: `${modelName(m)} · ${m.provider}/${m.model}` }))
          const chosen = await pick('model', items, 'Select model', selectedModelId)
          if (chosen) await setModel(chosen.id)
        }
      } else if (cmd.name === 'new') { activeSession = null; await makeSession(); term.line(term.colorize(activeSession ? `Started session ${activeSession.id}` : 'Choose a harness and model to start a session.', '\u001b[90m')) }
      else if (cmd.name === 'status') {
        term.line(`Workspace: ${short(client.workspace || options.workspace || process.cwd())}`)
        const pkg = packageFor(selectedPackageId)
        term.line(`Harness: ${activeIdentity().mark || '✳'} ${selectedPackageId ? `${packageName(pkg)} (${selectedPackageId}) v${pkg?.manifest.version || '?'}` : 'not selected'}`)
        if (pkg?.manifest.source) term.line(`Source agent: ${pkg.manifest.source.agent} v${pkg.manifest.source.version}`)
        term.line(`Model: ${selectedModelId ? `${modelName(modelFor(selectedModelId))} (${selectedModelId})` : 'not selected'}`)
        term.line(`Session: ${activeSession ? `${activeSession.title} · ${activeSession.id}` : 'none'}`)
        term.line(`Saved sessions: ${store.sessions.length}`)
      } else if (cmd.name === 'clear') { output.write('\u001b[2J\u001b[H'); drawBrand(); term.line(term.colorize(`${promptPrefix()}prompt     ? for shortcuts`, '\u001b[90m')) }
      else if (cmd.name === 'resume') {
        let found = cmd.arg ? store.sessions.find(s => s.id === cmd.arg || s.id.startsWith(cmd.arg)) : null
        if (!cmd.arg) {
          const recent = store.sessions.slice(0, 30)
          const items = recent.map(s => ({ id: s.id, label: `${getAgentIdentity(packageFor(s.packageId)?.manifest).mark || '✳'} ${s.title} · ${s.id.slice(0, 8)} · ${s.packageId} / ${s.modelId}` }))
          const chosen = await pick('session', items, 'Resume local session', activeSession?.id)
          if (chosen) found = recent.find(s => s.id === chosen.id)
        }
        if (!found) term.line(term.colorize('No matching local session.', '\u001b[33m'))
        else {
          const pkg = packageFor(found.packageId), model = modelFor(found.modelId)
          if (!sessionCompatible(found, pkg, model)) term.line(term.colorize('That session cannot be resumed because its workspace, harness version, compiled program, or model is unavailable.', '\u001b[31m'))
          else { activeSession = found; selectedPackageId = found.packageId; selectedModelId = found.modelId; drawBrand(true); term.line(`Resumed ${found.title} · ${found.id}`) }
        }
      } else if (cmd.name === 'quit' || cmd.name === 'exit') stopping = true
      else term.line(term.colorize(`Unknown command: /${cmd.name}. Try /help.`, '\u001b[33m'))
    }
    if (busy) await cancelBusy()
    return signalExitCode
  } finally { cleanup() }
}
