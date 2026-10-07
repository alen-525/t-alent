import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const COMPILER_VERSION = '0.2.0'
const MAX_MANIFEST_BYTES = 128 * 1024
const MAX_PROMPTS = 32
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_TOTAL_PROMPT_BYTES = 1024 * 1024
const MAX_PROMPT_TREE_DEPTH = 32
const MAX_PROMPT_TREE_ENTRIES = 128
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const MAX_STEPS = 128
const MAX_DEFAULT_DEPTH = 32
const ALLOWED_MANIFEST_KEYS = new Set(['schemaVersion', 'id', 'name', 'version', 'description', 'modelProtocols', 'source', 'prompts', 'logic'])
const ALLOWED_VARIABLES = new Set([
  'input', 'workspace', 'model.id', 'model.provider', 'model.model', 'model.protocol',
  'package.id', 'package.version', 'source.agent', 'source.version',
])
const FORBIDDEN_DEFAULT_KEYS = new Set(['model', 'provider', 'baseurl', 'apikey', 'apikeyenv'])

const memoryCache = new Map()

function fail(message) { throw new Error(`Invalid agent package: ${message}`) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function ownKeysAllowed(value, allowed, where) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unknown ${where} key "${key}".`)
}
function nonempty(value, max, where, pattern) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) fail(`${where} must be a valid non-empty string.`)
  return value
}
function semver(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value)
}
function plainJson(value, where, depth = 0) {
  if (depth > MAX_DEFAULT_DEPTH) fail(`${where} exceeds the maximum nesting depth.`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${where} contains a non-finite number.`); return }
  if (Array.isArray(value)) { for (const item of value) plainJson(item, where, depth + 1); return }
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${where} must contain only plain JSON values.`)
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${where} contains a forbidden object key.`)
    if (FORBIDDEN_DEFAULT_KEYS.has(key.toLowerCase())) fail(`${where} must not set model routing or credentials (${key}).`)
    plainJson(item, where, depth + 1)
  }
}

/** Validate and return a detached, normalized schema-v1 manifest. */
export function validateAgentManifest(raw) {
  if (!object(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail('manifest must be a JSON object.')
  ownKeysAllowed(raw, ALLOWED_MANIFEST_KEYS, 'manifest')
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1.')
  const id = nonempty(raw.id, 80, 'id', /^[a-z0-9][a-z0-9._-]{1,79}$/i)
  const name = nonempty(raw.name, 100, 'name')
  if (typeof raw.version !== 'string' || raw.version.length > 40 || !semver(raw.version)) fail('version must be a SemVer version up to 40 characters.')
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw.description))) fail('description must be a string up to 500 characters.')

  if (!Array.isArray(raw.modelProtocols) || raw.modelProtocols.length < 1 || raw.modelProtocols.length > 64) fail('modelProtocols must list at least one supported protocol.')
  const modelProtocols = raw.modelProtocols.map((protocol, index) => nonempty(protocol, 200, `modelProtocols[${index}]`, /^[A-Za-z0-9][A-Za-z0-9._-]*$/))
  if (new Set(modelProtocols).size !== modelProtocols.length) fail('modelProtocols must not contain duplicates.')

  if (!object(raw.source)) fail('source must be an object.')
  ownKeysAllowed(raw.source, new Set(['agent', 'version']), 'source')
  if (Object.keys(raw.source).length !== 2) fail('source must declare agent and version.')
  const source = {
    agent: nonempty(raw.source.agent, 100, 'source.agent'),
    version: nonempty(raw.source.version, 100, 'source.version'),
  }
  if (/^(?:latest|[~^<>=])/.test(source.version) || /[\s|~^*<>=]/.test(source.version) || /(?:^|\.)(?:x|X)(?:$|\.)/.test(source.version)) fail('source.version must be one exact version, not a range.')

  if (!object(raw.prompts) || Object.getPrototypeOf(raw.prompts) !== Object.prototype) fail('prompts must map logical names to files.')
  const promptNames = Object.keys(raw.prompts)
  if (!promptNames.length || promptNames.length > MAX_PROMPTS || !promptNames.includes('task')) fail('prompts must include task and contain at most 32 entries.')
  const prompts = {}
  const promptPaths = new Set()
  for (const promptName of promptNames.sort()) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(promptName)) fail(`invalid prompt name "${promptName}".`)
    const relative = nonempty(raw.prompts[promptName], 512, `prompts.${promptName}`)
    if (relative.includes('\\') || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative.split('/').some(part => !part || part === '.' || part === '..')) fail(`prompts.${promptName} must be a normalized relative path.`)
    if (promptPaths.has(relative)) fail('prompt files must not be mapped more than once.')
    promptPaths.add(relative)
    prompts[promptName] = relative
  }

  if (!object(raw.logic)) fail('logic must be an object.')
  ownKeysAllowed(raw.logic, new Set(['adapter', 'defaults', 'steps']), 'logic')
  const adapter = nonempty(raw.logic.adapter, 200, 'logic.adapter', /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  let defaults
  if (raw.logic.defaults !== undefined) {
    if (!object(raw.logic.defaults) || Object.getPrototypeOf(raw.logic.defaults) !== Object.prototype) fail('logic.defaults must be a plain JSON object.')
    plainJson(raw.logic.defaults, 'logic.defaults')
    defaults = JSON.parse(JSON.stringify(raw.logic.defaults))
  }
  if (!Array.isArray(raw.logic.steps) || !raw.logic.steps.length || raw.logic.steps.length > MAX_STEPS) fail('logic.steps must be a non-empty array of at most 128 steps.')
  let executeCount = 0
  let taskUnconditionalCount = 0
  let taskReferenceCount = 0
  const referenced = new Set()
  const steps = raw.logic.steps.map((step, index) => {
    if (!object(step)) fail(`logic.steps[${index}] must be an object.`)
    if (step.type === 'execute') {
      ownKeysAllowed(step, new Set(['type']), `logic.steps[${index}]`)
      executeCount++
      if (index !== raw.logic.steps.length - 1) fail('execute must be the final step.')
      return { type: 'execute' }
    }
    if (step.type !== 'prompt') fail(`logic.steps[${index}].type must be prompt or execute.`)
    ownKeysAllowed(step, new Set(['type', 'ref', 'when']), `logic.steps[${index}]`)
    const ref = nonempty(step.ref, 64, `logic.steps[${index}].ref`, /^[a-z][a-z0-9_-]*$/)
    if (!Object.hasOwn(prompts, ref)) fail(`logic.steps[${index}] references an unknown prompt "${ref}".`)
    referenced.add(ref)
    if (ref === 'task') {
      taskReferenceCount++
      if (step.when === undefined) taskUnconditionalCount++
    }
    let when
    if (step.when !== undefined) {
      if (!object(step.when)) fail(`logic.steps[${index}].when must be an object.`)
      ownKeysAllowed(step.when, new Set(['protocol', 'provider', 'model']), `logic.steps[${index}].when`)
      if (!Object.keys(step.when).length) fail(`logic.steps[${index}].when must contain at least one exact match.`)
      when = {}
      for (const key of ['protocol', 'provider', 'model']) if (step.when[key] !== undefined) when[key] = nonempty(step.when[key], 200, `logic.steps[${index}].when.${key}`)
    }
    return { type: 'prompt', ref, ...(when ? { when } : {}) }
  })
  if (executeCount !== 1 || steps.at(-1)?.type !== 'execute') fail('logic.steps must contain exactly one final execute step.')
  if (taskReferenceCount !== 1 || taskUnconditionalCount !== 1) fail('task prompt must be referenced exactly once and unconditionally.')
  for (const promptName of promptNames) if (!referenced.has(promptName)) fail(`prompt "${promptName}" is declared but never referenced.`)

  return {
    schemaVersion: 1,
    id,
    name,
    version: raw.version,
    ...(raw.description === undefined ? {} : { description: raw.description }),
    modelProtocols,
    source,
    prompts,
    logic: { adapter, ...(defaults === undefined ? {} : { defaults }), steps },
  }
}

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function inside(parent, child) { return child === parent || child.startsWith(parent + path.sep) }
function decodeUtf8(buffer, where) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { fail(`${where} must be valid UTF-8.`) }
}

async function inspectPromptTree(promptsRoot, expectedPaths) {
  const files = new Set()
  const dirs = new Set()
  let visited = 0
  async function walk(folder, relative = '', depth = 0) {
    if (depth > MAX_PROMPT_TREE_DEPTH) fail('prompts/ directory nesting is too deep.')
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++visited > MAX_PROMPT_TREE_ENTRIES) fail('prompts/ contains too many filesystem entries.')
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const childPath = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        dirs.add(childRelative)
        await walk(childPath, childRelative, depth + 1)
      } else if (entry.isSymbolicLink()) {
        let target
        try { target = await realpath(childPath) } catch { fail(`prompt path "${childRelative}" is a broken symlink.`) }
        if (!inside(promptsRoot, target)) fail(`prompt symlink "${childRelative}" escapes prompts/.`)
        const targetInfo = await stat(target)
        if (!targetInfo.isFile()) fail(`prompt symlink "${childRelative}" must resolve to a file.`)
        files.add(childRelative)
      } else if (entry.isFile()) files.add(childRelative)
      else fail(`unsupported entry in prompts/: "${childRelative}".`)
    }
  }
  await walk(promptsRoot)
  const expected = new Set(expectedPaths)
  if (files.size !== expected.size || [...files].some(file => !expected.has(file))) fail('prompts/ must contain exactly the files declared by the manifest.')
  for (const dir of dirs) {
    if (![...expected].some(file => file.startsWith(`${dir}/`))) fail(`unreferenced directory in prompts/: "${dir}".`)
  }
}

function compileTemplate(text, logicalName) {
  const parts = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    const strayClose = text.indexOf('}}', cursor)
    if (strayClose !== -1 && (open === -1 || strayClose < open)) fail(`prompt "${logicalName}" contains a malformed template expression.`)
    if (open === -1) {
      if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) })
      break
    }
    if (open > cursor) parts.push({ type: 'text', value: text.slice(cursor, open) })
    const close = text.indexOf('}}', open + 2)
    const nestedOpen = text.indexOf('{{', open + 2)
    if (close === -1 || (nestedOpen !== -1 && nestedOpen < close)) fail(`prompt "${logicalName}" contains a malformed template expression.`)
    const variable = text.slice(open + 2, close)
    if (!ALLOWED_VARIABLES.has(variable)) fail(`prompt "${logicalName}" uses unknown template variable "${variable}".`)
    parts.push({ type: 'variable', name: variable })
    cursor = close + 2
  }
  return parts
}

function sourceContext(program, input, workspace, model) {
  return {
    input: typeof input === 'string' ? input : '',
    workspace: typeof workspace === 'string' ? workspace : '',
    'model.id': typeof model?.id === 'string' ? model.id : '',
    'model.provider': typeof model?.provider === 'string' ? model.provider : '',
    'model.model': typeof model?.model === 'string' ? model.model : '',
    'model.protocol': typeof model?.protocol === 'string' ? model.protocol : '',
    'package.id': program.package.id,
    'package.version': program.package.version,
    'source.agent': program.source.agent,
    'source.version': program.source.version,
  }
}

/** Render matching prompt steps without evaluating template content. */
export function renderProgram(program, { input, workspace, model } = {}) {
  if (!object(program) || program.compilerVersion !== COMPILER_VERSION || program.schemaVersion !== 1) throw new Error('Unsupported compiled agent program.')
  const context = sourceContext(program, input, workspace, model)
  const rendered = []
  for (const step of program.steps) {
    if (step.type !== 'prompt') continue
    if (step.when && Object.entries(step.when).some(([field, expected]) => model?.[field] !== expected)) continue
    const parts = program.prompts[step.ref]
    if (!Array.isArray(parts)) throw new Error(`Compiled agent prompt is missing: ${step.ref}`)
    rendered.push(parts.map(part => part.type === 'text' ? part.value : context[part.name] ?? '').join(''))
  }
  return rendered.join('\n\n')
}

function makeProgram(manifest, templates) {
  const protocolLookup = Object.fromEntries(manifest.modelProtocols.map(protocol => [protocol, manifest.logic.adapter]))
  return {
    compilerVersion: COMPILER_VERSION,
    schemaVersion: 1,
    manifest,
    package: { id: manifest.id, version: manifest.version },
    source: { ...manifest.source },
    adapter: manifest.logic.adapter,
    defaults: manifest.logic.defaults ?? {},
    protocolLookup,
    prompts: templates,
    steps: manifest.logic.steps.map(step => ({ ...step, ...(step.when ? { when: { ...step.when } } : {}) })),
  }
}

function validateCachedTemplates(cached, manifest, sourceTexts) {
  if (!object(cached) || Object.getPrototypeOf(cached) !== Object.prototype) return null
  const names = Object.keys(manifest.prompts).sort()
  if (Object.keys(cached).sort().join('\0') !== names.join('\0')) return null
  const templates = {}
  for (const name of names) {
    const parts = cached[name]
    if (!Array.isArray(parts) || parts.length > sourceTexts[name].length) return null
    let rebuilt = ''
    let priorType = ''
    const checked = []
    for (const part of parts) {
      if (!object(part) || Object.getPrototypeOf(part) !== Object.prototype || typeof part.type !== 'string') return null
      if (part.type === 'text') {
        if (Object.keys(part).sort().join(',') !== 'type,value' || typeof part.value !== 'string' || !part.value || part.value.includes('{{') || part.value.includes('}}') || priorType === 'text') return null
        rebuilt += part.value
        checked.push({ type: 'text', value: part.value })
      } else if (part.type === 'variable') {
        if (Object.keys(part).sort().join(',') !== 'name,type' || typeof part.name !== 'string' || !ALLOWED_VARIABLES.has(part.name)) return null
        rebuilt += `{{${part.name}}}`
        checked.push({ type: 'variable', name: part.name })
      } else return null
      priorType = part.type
    }
    if (rebuilt !== sourceTexts[name]) return null
    templates[name] = checked
  }
  if (!templates.task?.some(part => part.type === 'variable' && part.name === 'input')) return null
  return templates
}

function cachePut(key, value) {
  memoryCache.delete(key)
  memoryCache.set(key, value)
  while (memoryCache.size > 128) memoryCache.delete(memoryCache.keys().next().value)
}

export function clearMemoryCache() {
  const removed = memoryCache.size
  memoryCache.clear()
  return removed
}

/**
 * Compile a declarative package. Every call rereads and validates source files;
 * cache entries are derived JSON only and never authorize a package load.
 */
export async function compileAgentPackage(packagePath, { cacheDir, cache = true } = {}) {
  const root = await realpath(packagePath)
  const rootEntries = (await readdir(root)).sort()
  if (rootEntries.length !== 2 || rootEntries[0] !== 'agent-package.json' || rootEntries[1] !== 'prompts') fail('schema-v1 package root may contain only agent-package.json and prompts/.')
  const manifestPath = path.join(root, 'agent-package.json')
  const manifestInfo = await lstat(manifestPath)
  if (manifestInfo.isSymbolicLink()) fail('agent-package.json must not be a symlink.')
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST_BYTES) fail('agent-package.json must be a file within the size limit.')
  const manifestBytes = await readFile(manifestPath)
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) fail('agent-package.json is too large.')
  let parsed
  try { parsed = JSON.parse(decodeUtf8(manifestBytes, 'agent-package.json')) } catch (error) {
    if (error?.message?.startsWith('Invalid agent package:')) throw error
    fail('agent-package.json is not valid JSON.')
  }
  const manifest = validateAgentManifest(parsed)
  const promptsEntry = path.join(root, 'prompts')
  if ((await lstat(promptsEntry)).isSymbolicLink()) fail('prompts/ must not be a symlink.')
  const promptsRoot = await realpath(promptsEntry)
  if (!inside(root, promptsRoot) || !(await stat(promptsRoot)).isDirectory()) fail('prompts/ must be a directory inside the package root.')
  await inspectPromptTree(promptsRoot, Object.values(manifest.prompts))

  let totalBytes = 0
  const rawPrompts = {}
  const promptHashes = {}
  for (const [logicalName, relative] of Object.entries(manifest.prompts)) {
    const filename = path.resolve(promptsRoot, ...relative.split('/'))
    const resolved = await realpath(filename)
    if (!inside(promptsRoot, resolved)) fail(`prompt "${logicalName}" resolves outside prompts/.`)
    const info = await stat(resolved)
    if (!info.isFile()) fail(`prompt "${logicalName}" is not a file.`)
    if (info.size > MAX_PROMPT_BYTES) fail(`prompt "${logicalName}" exceeds the per-file size limit.`)
    const bytes = await readFile(resolved)
    if (bytes.byteLength > MAX_PROMPT_BYTES) fail(`prompt "${logicalName}" exceeds the per-file size limit.`)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_TOTAL_PROMPT_BYTES) fail('prompts exceed the total size limit.')
    rawPrompts[logicalName] = decodeUtf8(bytes, `prompt "${logicalName}"`)
    promptHashes[logicalName] = { path: relative, sha256: hash(bytes) }
  }

  const canonicalManifest = stable(manifest)
  const fingerprint = hash([COMPILER_VERSION, root, canonicalManifest, stable(promptHashes)].join('\0'))
  if (cache !== false && memoryCache.has(fingerprint)) {
    const program = memoryCache.get(fingerprint)
    memoryCache.delete(fingerprint); memoryCache.set(fingerprint, program)
    return { manifest: deepFreeze(manifest), program, fingerprint, cache: { status: 'memory', entries: memoryCache.size, compiledTemplates: 0 } }
  }

  let cachePath
  let diskError
  if (cache !== false && cacheDir) {
    try {
      await mkdir(cacheDir, { recursive: true })
      const resolvedCacheDir = await realpath(cacheDir)
      cachePath = path.join(resolvedCacheDir, `${fingerprint}.json`)
      try {
        const cacheInfo = await lstat(cachePath)
        if (cacheInfo.isFile() && !cacheInfo.isSymbolicLink() && cacheInfo.size <= MAX_CACHE_BYTES) {
          const cacheBytes = await readFile(cachePath)
          const envelope = cacheBytes.byteLength <= MAX_CACHE_BYTES ? JSON.parse(decodeUtf8(cacheBytes, 'compiled cache')) : null
          if (object(envelope) && Object.keys(envelope).sort().join(',') === 'compilerVersion,fingerprint,program,programHash' && envelope.compilerVersion === COMPILER_VERSION && envelope.fingerprint === fingerprint && envelope.programHash === hash(stable(envelope.program))) {
            const diskTemplates = validateCachedTemplates(envelope.program?.prompts, manifest, rawPrompts)
            if (diskTemplates) {
              const diskProgram = makeProgram(manifest, diskTemplates)
              if (stable(diskProgram) === stable(envelope.program)) {
                const program = deepFreeze(diskProgram)
                if (cache !== false) cachePut(fingerprint, program)
                return { manifest: deepFreeze(manifest), program, fingerprint, cache: { status: 'disk', entries: memoryCache.size, path: cachePath, compiledTemplates: 0 } }
              }
            }
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') diskError = error?.message || String(error)
      }
    } catch (error) { diskError = error?.message || String(error) }
  }

  const templates = Object.fromEntries(Object.entries(rawPrompts).map(([name, text]) => [name, compileTemplate(text, name)]))
  if (!templates.task.some(part => part.type === 'variable' && part.name === 'input')) fail('task prompt must contain {{input}}.')
  const program = deepFreeze(makeProgram(manifest, templates))
  if (cache !== false) cachePut(fingerprint, program)
  if (cache !== false && cachePath) {
    try {
      const envelope = { compilerVersion: COMPILER_VERSION, fingerprint, programHash: hash(stable(program)), program }
      const tmpPath = `${cachePath}.${randomUUID()}.tmp`
      await writeFile(tmpPath, JSON.stringify(envelope), { mode: 0o600 })
      await rename(tmpPath, cachePath)
    } catch (error) { diskError = error?.message || String(error) }
  }
  return {
    manifest: deepFreeze(manifest),
    program,
    fingerprint,
    cache: { status: 'compiled', entries: memoryCache.size, compiledTemplates: Object.keys(templates).length, ...(cachePath ? { path: cachePath } : {}), ...(diskError ? { error: diskError } : {}) },
  }
}
