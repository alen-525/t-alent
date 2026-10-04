import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Package manifest must be a JSON object.')
  const { id, name, version, entry } = input
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(id)) throw new Error('Invalid package id.')
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Invalid package name.')
  if (typeof version !== 'string' || !version.trim() || version.length > 40) throw new Error('Invalid package version.')
  if (typeof entry !== 'string' || !entry.trim()) throw new Error('Package manifest must declare an entry path.')
  if (input.modelProtocols !== undefined && (!Array.isArray(input.modelProtocols) || input.modelProtocols.some(value => typeof value !== 'string' || !value.trim() || value.length > 200 || value !== value.trim()))) throw new Error('Invalid package modelProtocols.')
  return { id, name: name.trim(), version: version.trim(), ...(typeof input.description === 'string' ? { description: input.description.slice(0, 500) } : {}), ...(input.modelProtocols === undefined ? {} : { modelProtocols: [...new Set(input.modelProtocols)] }), entry }
}

export function parseHostArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package' || arg === '--workspace' || arg === '--port' || arg === '--state-dir' || arg === '--config' || arg === '--models') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`)
      const key = arg.slice(2).replaceAll('-', '')
      if (key === 'package') (options.package ??= []).push(value)
      else options[key] = value
    } else throw new Error(`Unknown host option: ${arg}`)
  }
  if (!options.workspace) throw new Error('--workspace is required.')
  options.port = options.port === undefined ? 8787 : Number(options.port)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be a valid TCP port.')
  return options
}

async function readConfig(filename) {
  if (!filename) return {}
  const value = JSON.parse(await readFile(filename, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Config must be a JSON object keyed by package id.')
  return value
}

async function readModels(filename) {
  if (!filename) return { profiles: [], defaultModelId: undefined }
  const value = JSON.parse(await readFile(filename, 'utf8'))
  const fail = () => { throw new Error('Invalid model registry.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['models', 'defaultModelId'].includes(key)) || !Array.isArray(value.models) || value.models.length > 1000) fail()
  const ids = new Set()
  const profiles = value.models.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'name', 'provider', 'model', 'protocol', 'apiKeyEnv', 'baseUrl'].includes(key))) fail()
    const { id, name, provider, model, protocol, apiKeyEnv, baseUrl } = entry
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || id !== id.trim() || ids.has(id)) fail()
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) fail()
    if (typeof provider !== 'string' || !provider.trim() || provider.length > 100) fail()
    if (typeof model !== 'string' || !model.trim() || model.length > 200) fail()
    if (typeof protocol !== 'string' || !protocol.trim() || protocol.length > 100) fail()
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) fail()
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || baseUrl !== baseUrl.trim()) fail()
      try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) fail() } catch { fail() }
    }
    ids.add(id)
    return Object.freeze({ id, ...(name === undefined ? {} : { name: name.trim() }), provider: provider.trim(), model: model.trim(), protocol: protocol.trim(), apiKeyEnv, ...(baseUrl === undefined ? {} : { baseUrl }) })
  })
  if (value.defaultModelId !== undefined && (typeof value.defaultModelId !== 'string' || !ids.has(value.defaultModelId))) fail()
  return { profiles, defaultModelId: value.defaultModelId }
}

/** Inspect metadata without importing code. Metadata registration never activates a package. */
export async function readPackageManifest(packagePath) {
  const dir = await realpath(packagePath)
  return validateManifest(JSON.parse(await readFile(path.join(dir, 'agent-package.json'), 'utf8')))
}

export async function loadPackage(packagePath, { workspace, stateRoot, env = process.env, config = {} }) {
  const packageDir = await realpath(packagePath)
  const manifest = validateManifest(JSON.parse(await readFile(path.join(packageDir, 'agent-package.json'), 'utf8')))
  const entry = await realpath(path.resolve(packageDir, manifest.entry))
  if (entry !== packageDir && !entry.startsWith(packageDir + path.sep)) throw new Error('Package entry must remain inside its package directory.')
  const module = await import(pathToFileURL(entry).href)
  if (typeof module.createAgentPackage !== 'function') throw new Error('Package entry must export createAgentPackage().')
  const stateDir = path.join(stateRoot, manifest.id)
  const runtime = await module.createAgentPackage({ workspace, stateDir, env, config: config[manifest.id] ?? {} })
  if (!runtime || typeof runtime.executeTask !== 'function' || typeof runtime.cancelTask !== 'function' || typeof runtime.dispose !== 'function') throw new Error('Package runtime does not implement the required API.')
  return { manifest, runtime }
}

function isLoopbackRequest(req) {
  const host = req.headers.host
  if (!host) return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return LOOPBACK.has(hostname)
}

function sameOriginRequest(req) {
  if (!isLoopbackRequest(req)) return false
  const origin = req.headers.origin
  if (!origin) return false
  try {
    const parsed = new URL(origin)
    const host = req.headers.host
    const site = req.headers['sec-fetch-site']
    const requestPort = host.includes(']:') ? host.slice(host.lastIndexOf(':') + 1) : host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : parsed.protocol === 'https:' ? '443' : '80'
    const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    const allowedPort = originPort === requestPort || originPort === '5173'
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOOPBACK.has(parsed.hostname) && allowedPort && (!site || site === 'same-origin' || site === 'same-site' || site === 'none')
  } catch { return false }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

async function bodyJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('Expected application/json.'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400 }) }
}

export async function createHost({ packagePath, packagePaths, workspace, stateDir = '.talent', configPath, modelsPath, port = 8787, env = process.env, bindHost = '127.0.0.1' } = {}) {
  const resolvedWorkspace = await realpath(workspace)
  const stateRoot = path.resolve(stateDir)
  const config = await readConfig(configPath)
  const modelRegistry = await readModels(modelsPath)
  const profilesById = new Map(modelRegistry.profiles.map(profile => [profile.id, profile]))
  const packages = new Map()
  const packageList = packagePaths ?? (packagePath ? [packagePath] : [])
  try {
    for (const localPath of packageList) {
      const loaded = await loadPackage(localPath, { workspace: resolvedWorkspace, stateRoot, env, config })
      if (packages.has(loaded.manifest.id)) {
        await loaded.runtime.dispose()
        throw new Error(`Duplicate loaded package id: ${loaded.manifest.id}`)
      }
      packages.set(loaded.manifest.id, loaded)
    }
  } catch (error) {
    await Promise.allSettled([...packages.values()].map(({ runtime }) => runtime.dispose()))
    throw error
  }
  const tasks = new Map()
  const sessionProfiles = new Map()
  const seenTaskIds = new Set()
  const unloading = new Set()
  let closed = false

  const cancelAndWait = async taskId => {
    const task = tasks.get(taskId)
    if (!task) return false
    if (!task.cancelPromise) {
      task.controller.abort()
      task.cancelPromise = Promise.resolve().then(() => task.runtime.cancelTask(taskId)).catch(error => { task.cancelPromise = undefined; throw error })
    }
    await task.cancelPromise
    await task.done
    return true
  }

  const server = createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!isLoopbackRequest(req)) return json(res, 403, { error: 'Loopback requests only.' })
    if (req.method === 'GET' && url.pathname === '/api/packages') return json(res, 200, { packages: [...packages.values()].map(({ manifest }) => ({ manifest, runtimeReady: true })) })
    if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, { models: modelRegistry.profiles.map(({ id, name, provider, model, protocol, baseUrl }) => ({ id, ...(name === undefined ? {} : { name }), provider, model, protocol, ...(baseUrl === undefined ? {} : { baseUrl }) })), ...(modelRegistry.defaultModelId === undefined ? {} : { defaultModelId: modelRegistry.defaultModelId }) })
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { connected: true })
    if (req.method === 'POST' && url.pathname.startsWith('/api/packages/') && url.pathname.endsWith('/unload')) {
      if (!sameOriginRequest(req)) return json(res, 403, { error: 'Same-origin requests are required.' })
      let body
      try { body = await bodyJson(req) } catch (error) { return json(res, error.status ?? 400, { error: error.message }) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'JSON request body must be an object.' })
      let id
      try { id = decodeURIComponent(url.pathname.slice('/api/packages/'.length, -'/unload'.length)) } catch { return json(res, 400, { error: 'Invalid package id.' }) }
      const loaded = packages.get(id)
      if (loaded) {
        unloading.add(id)
        try {
          const activeIds = [...tasks].filter(([, task]) => task.runtime === loaded.runtime).map(([taskId]) => taskId)
          await Promise.all(activeIds.map(cancelAndWait))
          await loaded.runtime.dispose()
          packages.delete(id)
        } finally { unloading.delete(id) }
      }
      return json(res, 200, { unloaded: true })
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' })
    if (!sameOriginRequest(req)) return json(res, 403, { error: 'Same-origin requests are required.' })
    let body
    try { body = await bodyJson(req) } catch (error) { return json(res, error.status ?? 400, { error: error.message }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'JSON request body must be an object.' })
    if (url.pathname === '/api/cancel') {
      if (typeof body.taskId !== 'string') return json(res, 400, { error: 'taskId is required.' })
      await cancelAndWait(body.taskId)
      return json(res, 200, { cancelled: true })
    }
    if (url.pathname !== '/api/tasks') return json(res, 404, { error: 'Not found.' })
    const { packageId, input, sessionId, taskId, modelId } = body
    if (Object.hasOwn(body, 'model') || Object.hasOwn(body, 'provider') || Object.hasOwn(body, 'apiKey') || Object.hasOwn(body, 'apiKeyEnv')) return json(res, 400, { error: 'Model configuration must be selected by modelId.' })
    if (typeof packageId !== 'string' || !packages.has(packageId) || unloading.has(packageId)) return json(res, 409, { error: 'No explicitly loaded package matches packageId.' })
    if (typeof modelId !== 'string' || !modelId.trim()) return json(res, 400, { error: 'modelId is required.' })
    const model = profilesById.get(modelId)
    if (!model) return json(res, 400, { error: 'Unknown modelId.' })
    const manifest = packages.get(packageId).manifest
    if (manifest.modelProtocols && !manifest.modelProtocols.includes(model.protocol)) return json(res, 409, { error: 'Selected model protocol is not supported by this package.' })
    if (typeof input !== 'string' || !input.trim()) return json(res, 400, { error: 'Task input must not be empty.' })
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(taskId) || seenTaskIds.has(taskId)) return json(res, 409, { error: 'taskId must be unique and valid.' })
    const { runtime } = packages.get(packageId)
    if ([...tasks.values()].some(task => task.runtime === runtime)) return json(res, 409, { error: 'This package already has an active task.' })
    if (typeof sessionId !== 'string' || !sessionId) return json(res, 400, { error: 'sessionId is required.' })
    if (sessionProfiles.has(sessionId) && sessionProfiles.get(sessionId) !== model.id) return json(res, 409, { error: 'This session is bound to a different model profile.' })
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-task-id': taskId })
    let responseClosed = false
    const task = { runtime, controller: new AbortController(), cancelPromise: undefined, done: undefined }
    tasks.set(taskId, task)
    sessionProfiles.set(sessionId, model.id)
    seenTaskIds.add(taskId)
    const write = event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n') }
    task.done = (async () => {
      try {
        const iterable = await runtime.executeTask({ taskId, input, sessionId, model }, { signal: task.controller.signal })
        for await (const event of iterable) {
          if (responseClosed) break
          write(event)
          if (event.type === 'error' || event.type === 'cancelled') break
        }
      } catch (error) {
        if (!responseClosed) write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        tasks.delete(taskId)
        if (!responseClosed && !res.writableEnded) res.end()
      }
    })()
    res.on('close', () => {
      if (!res.writableEnded) {
        responseClosed = true
        void cancelAndWait(taskId).catch(error => console.error(`Unable to stop disconnected task ${taskId}:`, error))
      }
    })
    })().catch(error => { console.error('Host request failed:', error); if (!res.headersSent) json(res, 500, { error: 'Host operation failed.' }); else if (!res.writableEnded) res.destroy() })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindHost, () => { server.off('error', reject); resolve() })
  })
  return {
    server,
    address: server.address(),
    packages: [...packages.values()].map(({ manifest }) => ({ manifest, runtimeReady: true })),
    async close() {
      if (closed) return
      closed = true
      const errors = []
      const stopped = await Promise.allSettled([...tasks.keys()].map(cancelAndWait))
      errors.push(...stopped.filter(row => row.status === 'rejected').map(row => row.reason))
      const disposed = await Promise.allSettled([...packages.values()].map(({ runtime }) => runtime.dispose()))
      errors.push(...disposed.filter(row => row.status === 'rejected').map(row => row.reason))
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(() => resolve()))
      if (errors.length) throw new AggregateError(errors, 'Some package tasks or runtimes did not shut down cleanly.')
    },
  }
}
