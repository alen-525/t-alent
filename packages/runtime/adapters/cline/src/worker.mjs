import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { devNull } from 'node:os'

let input = ''
for await (const chunk of process.stdin) input += chunk
const job = JSON.parse(input)
const send = event => process.stdout.write(JSON.stringify(event) + '\n')
let core, store, aborted = false, unsubscribe, doneEvent
const sessionId = randomUUID()
const abort = () => { aborted = true; void core?.abort(sessionId, 'Host cancelled task').catch(() => {}) }
process.once('SIGTERM', abort); process.once('SIGINT', abort)
try {
  // The SDK's hook audit contains raw provider diagnostics. Host events carry
  // redacted diagnostics; do not persist a second unredacted audit stream.
  process.env.CLINE_HOOKS_LOG_PATH = devNull
  const sdk = await import('@cline/core')
  sdk.setHomeDir(resolve(job.stateDir, 'home'))
  sdk.setClineDir(resolve(job.stateDir, 'home', '.cline'))
  const nativeDir = resolve(job.stateDir, 'native')
  await mkdir(nativeDir, { recursive: true, mode: 0o700 })
  store = new sdk.SqliteSessionStore({ sessionsDir: nativeDir }); store.init()
  const secret = process.env.TALENT_CLINE_KEY
  const redact = value => {
    if (typeof value === 'string') return secret ? value.replaceAll(secret, '[redacted]') : value
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
    return value
  }
  // Keep the original SDK persistence format, while filtering exact credential
  // echoes before the SDK writes provider messages and compaction sidecars.
  class RedactedSessionService extends sdk.CoreSessionService {
    persistSessionMessages(id, messages, systemPrompt) { return super.persistSessionMessages(id, redact(messages), redact(systemPrompt)) }
    persistSessionCompactionState(id, state) { return super.persistSessionCompactionState(id, redact(state)) }
  }
  const sessionService = new RedactedSessionService(store, { sessionArtifactsDir: nativeDir })
  core = await sdk.ClineCore.create({ clientName: 't-alent', distinctId: 't-alent-local', backendMode: 'local', sessionService })
  if (aborted) { send({ type: 'cancelled' }); process.exitCode = 0 }
  else {
    unsubscribe = core.subscribe(({ type, payload }) => {
      if (aborted || type !== 'agent_event' || payload.sessionId !== sessionId) return
      const event = payload.event
      if (event.type === 'content_start') {
        if (event.contentType === 'text' && event.text) send({ type: 'assistant-delta', text: event.text })
        if (event.contentType === 'reasoning' && event.reasoning) send({ type: 'reasoning', text: event.reasoning })
        if (event.contentType === 'tool') send({ type: 'tool-call', name: event.toolName, callId: event.toolCallId, input: event.input })
      } else if (event.type === 'content_end' && event.contentType === 'tool') send({ type: 'tool-result', name: event.toolName, callId: event.toolCallId, output: event.output ?? event.error, status: event.error ? 'error' : 'success' })
      else if (event.type === 'done') doneEvent = event
      else if (event.type === 'error') send({ type: 'harness-event', event: { type: 'provider-error', message: event.error?.message, recoverable: event.recoverable } })
      else if (['notice','usage'].includes(event.type)) send({ type: 'harness-event', event })
    })
    let initialMessages
    const transcriptPath = resolve(job.stateDir, 'transcript.json')
    try { initialMessages = JSON.parse(await readFile(transcriptPath, 'utf8')); if(!Array.isArray(initialMessages)) throw new Error('Invalid persisted Cline transcript') } catch(e) { if(e.code!=='ENOENT') throw e }
    const providerId = 'openai-compatible'
    const providerConfig = { providerId, clientType: 'openai-compatible', modelId: job.profile.model, apiKey: process.env.TALENT_CLINE_KEY,
      baseUrl: job.profile.baseUrl ?? 'https://api.openai.com/v1', maxOutputTokens: 8192,
      knownModels: { [job.profile.model]: { id: job.profile.model, name: job.profile.model, contextWindow: 200000, maxTokens: 8192, supportsImages: false, supportsPromptCache: false, inputPrice: 0, outputPrice: 0 } } }
    send({ type: 'session', sessionId })
    const result = await core.start({
      config: { sessionId, providerId, modelId: job.profile.model, apiKey: process.env.TALENT_CLINE_KEY, baseUrl: providerConfig.baseUrl, providerConfig,
        cwd: job.workspace, workspaceRoot: job.workspace, mode: 'act', enableTools: true, enableSpawnAgent: false, enableAgentTeams: false, disableMcpSettingsTools: true,
        systemPrompt: sdk.getClineDefaultSystemPrompt({ workspaceRoot: job.workspace, cwd: job.workspace, mode: 'act', providerId, ...(job.config.instructions ? { rules: job.config.instructions } : {}) }),
        maxIterations: job.config.maxIterations ?? 30, checkpoint: { enabled: false } },
      initialMessages, prompt: job.input, interactive: false,
      localRuntime: { modelCatalogDefaults: { loadLatestOnInit: false, includeClineCloudModels: false, loadPrivateOnAuth: false } },
    })
    if (aborted || result.result?.finishReason === 'aborted') send({ type: 'cancelled' })
    else if (result.result?.finishReason !== 'completed') throw new Error(`Cline turn ended with ${result.result?.finishReason ?? doneEvent?.reason ?? 'no result'}`)
    else {
      const messages = await core.readMessages(result.sessionId)
      const temporary = `${transcriptPath}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(redact(messages)), { mode: 0o600 }); await rename(temporary, transcriptPath)
      send({ type: 'assistant-replace', text: result.result.text }); send({ type: 'assistant-complete' })
    }
  }
} catch(e) { send(aborted ? { type: 'cancelled' } : { type: 'error', message: e instanceof Error ? e.message : String(e) }); process.exitCode = aborted ? 0 : 1 }
finally { unsubscribe?.(); await core?.dispose(); store?.close(); process.removeListener('SIGTERM',abort); process.removeListener('SIGINT',abort) }
