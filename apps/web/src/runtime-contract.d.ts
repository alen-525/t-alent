import type { AgentPackageManifest, ModelCatalog, ModelProfile, TaskEvent } from './host-adapter'

export function validateManifest(input: unknown): AgentPackageManifest
export function validateModelCatalog(input: unknown): ModelCatalog
export function supportsModel(manifest: AgentPackageManifest, model: ModelProfile): boolean
export function registeredRecord(manifest: AgentPackageManifest): { manifest: AgentPackageManifest; runtimeReady: false }
export function isRunnable(packages: readonly { manifest: AgentPackageManifest; runtimeReady: boolean }[], selectedId: string, adapter: unknown): boolean
export function appendTaskEvent(turns: readonly { role: 'user' | 'assistant' | 'tool'; text: string }[], event: TaskEvent): Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>
