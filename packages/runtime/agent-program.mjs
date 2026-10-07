import { createHash } from 'node:crypto'
import { renderProgram } from './agent-compiler.mjs'

/** Execute a compiled recipe through a framework-owned Harness adapter. */
export function createProgramRuntime({ program, fingerprint, runtime, workspace }) {
  let disposed = false
  const protocols = new Set(program.manifest.modelProtocols)
  return {
    executeTask(task, options) {
      if (disposed) throw new Error('Agent program is disposed.')
      if (!task?.model || typeof task.model !== 'object') throw new TypeError('A model profile is required.')
      if (!protocols.has(task.model.protocol)) throw new TypeError(`Unsupported model profile protocol: ${task.model.protocol}`)
      if (typeof task.input !== 'string' || !task.input.trim()) throw new TypeError('Task input must not be empty.')
      const input = renderProgram(program, { input: task.input, model: task.model, workspace })
      // A changed program must not silently reuse an upstream conversation's old instructions.
      const sessionId = createHash('sha256').update(JSON.stringify([task.sessionId || task.taskId, fingerprint])).digest('hex')
      return runtime.executeTask({ ...task, input, sessionId }, options)
    },
    cancelTask(taskId) { return runtime.cancelTask(taskId) },
    async dispose() {
      if (disposed) return
      disposed = true
      await runtime.dispose()
    },
  }
}
