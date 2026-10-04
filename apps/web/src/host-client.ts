import type { AgentPackageManifest, HostAdapter, ModelCatalog, TaskEvent } from './host-adapter'

type PackageRow = { manifest: AgentPackageManifest; runtimeReady: boolean }
const metadata = new Map<string, AgentPackageManifest>()
let connected = false
let nextTask = 0
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++nextTask).toString(36)}`

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(detail.error || `Host returned HTTP ${response.status}.`)
  }
  return response
}

export const hostClient: HostAdapter = {
  get connected() { return connected },
  async listPackages() {
    const response = await request('packages')
    const result = await response.json() as { packages: PackageRow[] }
    connected = true
    return [...result.packages, ...[...metadata.values()].filter(manifest => !result.packages.some(row => row.manifest.id === manifest.id)).map(manifest => ({ manifest, runtimeReady: false }))]
  },
  async registerPackage(manifest) { metadata.set(manifest.id, manifest) },
  async uninstallPackage(id) {
    metadata.delete(id)
    if (connected) await request(`packages/${encodeURIComponent(id)}/unload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  },
  async listModels(): Promise<ModelCatalog> {
    const response = await request('models')
    return await response.json() as ModelCatalog
  },
  executeTask(task) {
    if (!task.input.trim()) throw new Error('Task input must not be empty.')
    const taskId = task.taskId || randomId()
    return (async function* (): AsyncGenerator<TaskEvent> {
      const response = await request('tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...task, taskId }) })
      if (!response.body) throw new Error('Host did not return a task event stream.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) yield JSON.parse(line) as TaskEvent
          if (done) break
        }
        if (buffer.trim()) yield JSON.parse(buffer) as TaskEvent
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    })()
  },
  async cancelTask(taskId) {
    await request('cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) })
  },
}

/** Quietly probe the optional local host and notify the UI only when its state changes. */
export function startHostClient() {
  window.talentHostAdapter = hostClient
  let stopped = false
  let timer: number | undefined
  let probing = false
  const probe = async () => {
    if (stopped || probing) return
    probing = true
    let available = false
    try { await request('health'); available = true } catch { available = false } finally { probing = false }
    if (available !== connected) {
      connected = available
      window.dispatchEvent(new Event('talent:host-ready'))
    }
    timer = window.setTimeout(probe, available ? 5000 : 2000)
  }
  void probe()
  window.dispatchEvent(new Event('talent:host-ready'))
  return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer) }
}
