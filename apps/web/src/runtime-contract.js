/** Small host boundary helpers shared by the UI and Node's built-in tests. */
export function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Descriptor must be a JSON object.')
  const value = input
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value.id)) throw new Error('id must be 2–80 letters, numbers, dots, underscores, or hyphens.')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('name must be a non-empty string up to 100 characters.')
  if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 40) throw new Error('version must be a non-empty string up to 40 characters.')
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500)) throw new Error('description must be at most 500 characters.')
  if (value.modelProtocols !== undefined && (!Array.isArray(value.modelProtocols) || value.modelProtocols.some(protocol => typeof protocol !== 'string' || !protocol.trim()))) throw new Error('modelProtocols must be an array of non-empty protocol names.')
  return { id: value.id, name: value.name.trim(), version: value.version.trim(), ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(typeof value.entry === 'string' ? { entry: value.entry } : {}), ...(Array.isArray(value.modelProtocols) ? { modelProtocols: [...new Set(value.modelProtocols.map(protocol => protocol.trim()))] } : {}) }
}

export function validateModelCatalog(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['models', 'defaultModelId'].includes(key)) || !Array.isArray(input.models)) throw new Error('Host returned an invalid model catalog.')
  const models = input.models.map(model => {
    const allowed = new Set(['id', 'name', 'provider', 'model', 'protocol', 'baseUrl'])
    if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).some(key => !allowed.has(key))) throw new Error('Host returned an invalid model profile.')
    if (typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || typeof model.provider !== 'string' || !model.provider.trim() || typeof model.model !== 'string' || !model.model.trim() || typeof model.protocol !== 'string' || !model.protocol.trim()) throw new Error('Host returned an invalid model profile.')
    if (model.name !== undefined && (typeof model.name !== 'string' || !model.name.trim())) throw new Error('Host returned an invalid model profile.')
    if (model.baseUrl !== undefined && typeof model.baseUrl !== 'string') throw new Error('Host returned an invalid model profile.')
    return { id: model.id, ...(typeof model.name === 'string' ? { name: model.name } : {}), provider: model.provider, model: model.model, protocol: model.protocol, ...(typeof model.baseUrl === 'string' ? { baseUrl: model.baseUrl } : {}) }
  })
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Host returned duplicate model IDs.')
  if (input.defaultModelId !== undefined && (typeof input.defaultModelId !== 'string' || !models.some(model => model.id === input.defaultModelId))) throw new Error('Host returned an invalid default model ID.')
  return { models, ...(typeof input.defaultModelId === 'string' ? { defaultModelId: input.defaultModelId } : {}) }
}

export function supportsModel(manifest, model) { return manifest.modelProtocols === undefined || manifest.modelProtocols.includes(model.protocol) }

export function registeredRecord(manifest) { return { manifest, runtimeReady: false } }

export function isRunnable(packages, selectedId, adapter) {
  return Boolean(adapter && adapter.connected !== false && selectedId && packages.some(item => item.manifest.id === selectedId && item.runtimeReady))
}

export function appendTaskEvent(turns, event) {
  if (event.type === 'assistant-delta') {
    const last = turns.at(-1)
    return last?.role === 'assistant'
      ? [...turns.slice(0, -1), { role: 'assistant', text: last.text + event.text }]
      : [...turns, { role: 'assistant', text: event.text }]
  }
  if (event.type === 'assistant-replace') {
    const lastAssistant = turns.findLastIndex(turn => turn.role === 'assistant')
    return lastAssistant < 0
      ? [...turns, { role: 'assistant', text: event.text }]
      : turns.map((turn, index) => index === lastAssistant ? { role: 'assistant', text: event.text } : turn)
  }
  if (event.type === 'tool-call') return [...turns, { role: 'tool', text: `${event.name} · ${JSON.stringify(event.input ?? '')}` }]
  if (event.type === 'tool-result') return [...turns, { role: 'tool', text: `${event.name} · ${JSON.stringify(event.output ?? '')}` }]
  if (event.type === 'cancelled') return [...turns, { role: 'tool', text: 'Task cancelled' }]
  if (event.type === 'error') return [...turns, { role: 'tool', text: `Task error · ${event.message}` }]
  return turns
}
