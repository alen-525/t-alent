/** Trusted native runtime adapters. Recipe data may select an entry but cannot add code. */
export const ADAPTERS = Object.freeze({
  codex: Object.freeze({
    sourceVersion: '0.159.3',
    modelProtocols: Object.freeze(['openai-responses']),
    create: async options => (await import('./codex/src/index.mjs')).createAgentPackage(options),
  }),
  deepseek: Object.freeze({
    sourceVersion: '0.2.0-rc.2',
    modelProtocols: Object.freeze(['deepseek']),
    create: async options => (await import('./deepseek/src/index.mjs')).createAgentPackage(options),
  }),
  pi: Object.freeze({
    sourceVersion: '0.73.1',
    modelProtocols: Object.freeze(['openai-chat-completions', 'openai-responses', 'anthropic', 'google-generative-ai']),
    create: async options => (await import('./pi/src/index.mjs')).createAgentPackage(options),
  }),
  opencode: Object.freeze({
    sourceVersion: '1.18.32',
    modelProtocols: Object.freeze(['openai-chat-completions', 'anthropic', 'openai-responses']),
    create: async options => (await import('./opencode/src/index.mjs')).createAgentPackage(options),
  }),
  gemini: Object.freeze({
    sourceVersion: '0.62.0',
    modelProtocols: Object.freeze(['google-generative-ai']),
    create: async options => (await import('./gemini/src/index.mjs')).createAgentPackage(options),
  }),
  goose: Object.freeze({
    sourceVersion: '1.48.0',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./goose/src/index.mjs')).createAgentPackage(options),
  }),
  cline: Object.freeze({
    sourceVersion: '0.0.90',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./cline/src/index.mjs')).createAgentPackage(options),
  }),
  continue: Object.freeze({
    sourceVersion: '1.5.47',
    modelProtocols: Object.freeze(['openai-chat-completions', 'anthropic']),
    create: async options => (await import('./continue/src/index.mjs')).createAgentPackage(options),
  }),
  qwen: Object.freeze({
    sourceVersion: '0.24.7',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./qwen/src/index.mjs')).createAgentPackage(options),
  }),
  kilo: Object.freeze({
    sourceVersion: '7.8.3',
    modelProtocols: Object.freeze(['openai-chat-completions', 'anthropic', 'openai-responses']),
    create: async options => (await import('./kilo/src/index.mjs')).createAgentPackage(options),
  }),
  aider: Object.freeze({
    sourceVersion: '0.86.2',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./aider/src/index.mjs')).createAgentPackage(options),
  }),
  openclaw: Object.freeze({
    sourceVersion: '2026.9.8',
    modelProtocols: Object.freeze(['openai-chat-completions', 'openai-responses', 'anthropic']),
    create: async options => (await import('./openclaw/src/index.mjs')).createAgentPackage(options),
  }),
  openhands: Object.freeze({
    sourceVersion: '1.51.0',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./openhands/src/index.mjs')).createAgentPackage(options),
  }),
  'mini-swe-agent': Object.freeze({
    sourceVersion: '2.4.6',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./mini-swe-agent/src/index.mjs')).createAgentPackage(options),
  }),
  deepagents: Object.freeze({
    sourceVersion: '0.7.21',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./deepagents/src/index.mjs')).createAgentPackage(options),
  }),
  'mistral-vibe': Object.freeze({
    sourceVersion: '2.25.8',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./mistral-vibe/src/index.mjs')).createAgentPackage(options),
  }),
  'swe-agent': Object.freeze({
    sourceVersion: '1.1.0',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./swe-agent/src/index.mjs')).createAgentPackage(options),
  }),
  'open-interpreter': Object.freeze({
    sourceVersion: '0.4.3',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./open-interpreter/src/index.mjs')).createAgentPackage(options),
  }),
  'roo': Object.freeze({
    sourceVersion: '0.1.17',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./roo/src/index.mjs')).createAgentPackage(options),
  }),
  'nanobot': Object.freeze({
    sourceVersion: '0.3.5',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./nanobot/src/index.mjs')).createAgentPackage(options),
  }),
  'smolagents': Object.freeze({
    sourceVersion: '1.26.0',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./smolagents/src/index.mjs')).createAgentPackage(options),
  }),
  'magentic-one': Object.freeze({
    sourceVersion: '0.7.5',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./magentic-one/src/index.mjs')).createAgentPackage(options),
  }),
  'hermes': Object.freeze({
    sourceVersion: '0.21.3',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./hermes/src/index.mjs')).createAgentPackage(options),
  }),
  'crewai': Object.freeze({
    sourceVersion: '1.15.23',
    modelProtocols: Object.freeze(['openai-chat-completions']),
    create: async options => (await import('./crewai/src/index.mjs')).createAgentPackage(options),
  }),
})

export async function createAdapter(adapterId, options) {
  if (typeof adapterId !== 'string' || !Object.hasOwn(ADAPTERS, adapterId)) {
    throw new Error(`Unsupported native adapter: ${String(adapterId)}`)
  }
  return ADAPTERS[adapterId].create(options)
}
