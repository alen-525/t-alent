/** Neutral bridge from the presentation framework to an independently owned host. */
export type AgentPackageManifest = { id: string; name: string; version: string; description?: string; entry?: string; modelProtocols?: string[] }
export type ModelProfile = { id: string; name?: string; provider: string; model: string; protocol: string; baseUrl?: string }
export type ModelCatalog = { models: ModelProfile[]; defaultModelId?: string }
/** A single user task. sessionId identifies the UI conversation, never a provider session. */
export type AgentTask = { taskId: string; sessionId: string; input: string; packageId: string; modelId: string; attachments?: File[] }
/** Neutral presentation events; harness-event preserves package diagnostics without requiring UI rendering. */
export type TaskEvent = { type: 'assistant-delta'; text: string } | { type: 'assistant-replace'; text: string } | { type: 'assistant-complete' } | { type: 'reasoning'; text: string } | { type: 'tool-call'; name: string; input?: unknown } | { type: 'tool-result'; name: string; output?: unknown } | { type: 'error'; message: string } | { type: 'cancelled' } | { type: 'session'; sessionId: string } | { type: 'harness-event'; event: unknown }
export type HostAdapter = {
  readonly connected?: boolean
  listPackages: () => Promise<Array<{ manifest: AgentPackageManifest; runtimeReady: boolean }>>
  /** Register metadata with the host. This does not imply code activation. */
  registerPackage: (manifest: AgentPackageManifest) => Promise<void>
  uninstallPackage: (id: string) => Promise<void>
  /** List externally configured models, independently of agent packages. */
  listModels: () => Promise<ModelCatalog>
  /** Start one explicitly selected package task and yield presentation events. */
  executeTask: (task: AgentTask) => AsyncIterable<TaskEvent>
  /** Cancel a task by its unique task id and resolve after it has actually stopped. */
  cancelTask: (taskId: string) => Promise<void>
}

declare global { interface Window { talentHostAdapter?: HostAdapter } }
