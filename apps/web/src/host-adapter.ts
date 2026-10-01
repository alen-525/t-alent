/** Neutral bridge from the presentation framework to an independently owned host. */
export type AgentPackageManifest = { id: string; name: string; version: string; description?: string; entry?: string }
export type AgentTask = { input: string; packageId: string; attachments?: File[] }
export type TaskEvent = { type: 'assistant-delta'; text: string } | { type: 'assistant-complete' } | { type: 'tool-call'; name: string; input?: unknown } | { type: 'tool-result'; name: string; output?: unknown } | { type: 'error'; message: string } | { type: 'cancelled' }
export type HostAdapter = {
  listPackages: () => Promise<Array<{ manifest: AgentPackageManifest; runtimeReady: boolean }>>
  /** Register metadata with the host. This does not imply code activation. */
  registerPackage: (manifest: AgentPackageManifest) => Promise<void>
  uninstallPackage: (id: string) => Promise<void>
  /** Start one explicitly selected package task and yield presentation events. */
  executeTask: (task: AgentTask) => AsyncIterable<TaskEvent>
  /** Ask the host to cancel its task for this package. */
  cancelTask?: (packageId: string) => Promise<void>
}

declare global { interface Window { talentHostAdapter?: HostAdapter } }
