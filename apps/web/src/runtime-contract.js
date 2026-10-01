/** Small host boundary helpers shared by the UI and Node's built-in tests. */
export function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Descriptor must be a JSON object.')
  const value = input
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value.id)) throw new Error('id must be 2–80 letters, numbers, dots, underscores, or hyphens.')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('name must be a non-empty string up to 100 characters.')
  if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 40) throw new Error('version must be a non-empty string up to 40 characters.')
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500)) throw new Error('description must be at most 500 characters.')
  return { id: value.id, name: value.name.trim(), version: value.version.trim(), ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(typeof value.entry === 'string' ? { entry: value.entry } : {}) }
}

export function registeredRecord(manifest) { return { manifest, runtimeReady: false } }

export function isRunnable(packages, selectedId, adapter) {
  return Boolean(adapter && selectedId && packages.some(item => item.manifest.id === selectedId && item.runtimeReady))
}

export function appendTaskEvent(turns, event) {
  if (event.type === 'assistant-delta') {
    const last = turns.at(-1)
    return last?.role === 'assistant'
      ? [...turns.slice(0, -1), { role: 'assistant', text: last.text + event.text }]
      : [...turns, { role: 'assistant', text: event.text }]
  }
  if (event.type === 'tool-call') return [...turns, { role: 'tool', text: `${event.name} · ${JSON.stringify(event.input ?? '')}` }]
  if (event.type === 'tool-result') return [...turns, { role: 'tool', text: `${event.name} · ${JSON.stringify(event.output ?? '')}` }]
  if (event.type === 'cancelled') return [...turns, { role: 'tool', text: 'Task cancelled' }]
  if (event.type === 'error') return [...turns, { role: 'tool', text: `Task error · ${event.message}` }]
  return turns
}
