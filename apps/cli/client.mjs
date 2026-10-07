import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { loadPackage, readConfig, readModels } from '../../packages/runtime/host.mjs'

export async function createLocalClient({ packagePaths = [], workspace, stateDir = '.talent', configPath, modelsPath, env = process.env } = {}) {
  const resolvedWorkspace = await realpath(workspace)
  const stateRoot = path.resolve(stateDir)
  const config = await readConfig(configPath)
  const registry = await readModels(modelsPath)
  const profilesById = new Map(registry.profiles.map(profile => [profile.id, profile]))
  const packages = new Map()
  try {
    for (const packagePath of packagePaths) {
      const loaded = await loadPackage(packagePath, { workspace: resolvedWorkspace, stateRoot, env, config })
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
  const seenTaskIds = new Set()
  const sessionBindings = new Map()
  let closed = false
  let closing

  const cancelAndWait = async taskId => {
    const task = tasks.get(taskId)
    if (!task) return false
    if (!task.cancelPromise) {
      task.controller.abort()
      task.cancelPromise = Promise.resolve().then(() => task.runtime.cancelTask(taskId))
    }
    try { await task.stop?.() } catch (error) { task.stopError = error }
    try { await task.cancelPromise } catch (error) { task.cancelError = error }
    await task.done
    if (task.cancelError || task.stopError) throw new AggregateError([task.cancelError, task.stopError].filter(Boolean), 'Task cancellation did not complete cleanly.')
    return true
  }

  const client = {
    workspace: resolvedWorkspace,
    packages: [...packages.values()].map(({ manifest, compilation }) => ({ manifest, runtimeReady: true, ...(compilation ? { compilation } : {}) })),
    models: registry.profiles.map(({ id, name, provider, model, protocol, baseUrl }) => ({ id, ...(name === undefined ? {} : { name }), provider, model, protocol, ...(baseUrl === undefined ? {} : { baseUrl }) })),
    ...(registry.defaultModelId === undefined ? {} : { defaultModelId: registry.defaultModelId }),
    executeTask({ taskId, sessionId, packageId, modelId, input }) {
      let task
      const generator = (async function* () {
      if (closed) throw new Error('Local client is closed.')
      if (typeof packageId !== 'string' || !packages.has(packageId)) throw new Error('No explicitly loaded package matches packageId.')
      if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('modelId is required.')
      const model = profilesById.get(modelId)
      if (!model) throw new Error('Unknown modelId.')
      const loaded = packages.get(packageId)
      if (loaded.manifest.modelProtocols && !loaded.manifest.modelProtocols.includes(model.protocol)) throw new Error('Selected model protocol is not supported by this package.')
      if (typeof input !== 'string' || !input.trim()) throw new Error('Task input must not be empty.')
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(taskId) || seenTaskIds.has(taskId)) throw new Error('taskId must be unique and valid.')
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required.')
      if (tasks.size) throw new Error('Only one task may run at a time in this client.')
      const binding = `${packageId}\0${model.id}`
      if (sessionBindings.has(sessionId) && sessionBindings.get(sessionId) !== binding) throw new Error('This session is bound to a different package or model profile.')
      seenTaskIds.add(taskId)
      sessionBindings.set(sessionId, binding)

      task = { runtime: loaded.runtime, controller: new AbortController(), done: undefined, cancelPromise: undefined, stop: undefined }
      tasks.set(taskId, task)
      task.stop = () => generator.return()
      let resolveDone
      task.done = new Promise(resolve => { resolveDone = resolve })
      try {
        const iterable = await loaded.runtime.executeTask({ taskId, input, sessionId, model }, { signal: task.controller.signal })
        for await (const event of iterable) {
          yield event
          if (event?.type === 'error' || event?.type === 'cancelled') break
        }
      } finally {
        tasks.delete(taskId)
        resolveDone()
      }
      })()
      return {
        [Symbol.asyncIterator]() { return this },
        next(value) { return generator.next(value) },
        return(value) { return generator.return(value) },
        throw(error) { return generator.throw(error) },
      }
    },
    async cancelTask(taskId) { return cancelAndWait(taskId) },
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        const stopped = await Promise.allSettled([...tasks.keys()].map(cancelAndWait))
        const disposed = await Promise.allSettled([...packages.values()].map(({ runtime }) => runtime.dispose()))
        const errors = [...stopped, ...disposed].filter(result => result.status === 'rejected').map(result => result.reason)
        if (errors.length) throw new AggregateError(errors, 'Some package tasks or runtimes did not shut down cleanly.')
      })()
      return closing
    },
  }
  return client
}
