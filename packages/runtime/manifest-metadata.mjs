/** Browser-safe public metadata projection; recipes and credentials never cross this boundary. */
export function validatePackageMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Descriptor must be a JSON object.')
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value.id)) throw new Error('id must be 2–80 letters, numbers, dots, underscores, or hyphens.')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw new Error('name must be a non-empty string up to 100 characters.')
  if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 40) throw new Error('version must be a non-empty string up to 40 characters.')
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500)) throw new Error('description must be at most 500 characters.')
  if (value.modelProtocols !== undefined && (!Array.isArray(value.modelProtocols) || value.modelProtocols.some(protocol => typeof protocol !== 'string' || !protocol.trim() || protocol !== protocol.trim() || protocol.length > 200))) throw new Error('modelProtocols must be an array of non-empty protocol names.')
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('Unsupported Agent package schemaVersion.')
  if (value.schemaVersion === 1 && value.entry !== undefined) throw new Error('Declarative packages cannot declare an executable entry.')
  let source
  if (value.source !== undefined) {
    const original = value.source
    if (!original || typeof original !== 'object' || Array.isArray(original) || Object.keys(original).some(key => !['agent', 'version'].includes(key))) throw new Error('source must contain an agent and version.')
    for (const key of ['agent', 'version']) if (typeof original[key] !== 'string' || !original[key].trim() || original[key].length > 100 || /[\u0000-\u001f\u007f]/.test(original[key])) throw new Error(`Invalid source ${key}.`)
    source = { agent: original.agent, version: original.version }
  } else if (value.schemaVersion === 1) throw new Error('Declarative packages must record their source Agent version.')
  return {
    id: value.id, name: value.name.trim(), version: value.version.trim(),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(typeof value.entry === 'string' ? { entry: value.entry } : {}),
    ...(value.modelProtocols === undefined ? {} : { modelProtocols: [...new Set(value.modelProtocols)] }),
    ...(value.schemaVersion === undefined ? {} : { schemaVersion: value.schemaVersion }),
    ...(source === undefined ? {} : { source }),
  }
}
