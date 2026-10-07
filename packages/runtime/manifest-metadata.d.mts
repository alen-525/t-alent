export type AgentPackageMetadata = {
  id: string
  name: string
  version: string
  description?: string
  entry?: string
  schemaVersion?: 1
  modelProtocols?: string[]
  source?: { agent: string; version: string }
}
export function validatePackageMetadata(value: unknown): AgentPackageMetadata
