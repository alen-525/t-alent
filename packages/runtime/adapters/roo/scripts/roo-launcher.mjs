import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const executable = resolve(process.argv[2])
const root = resolve(dirname(executable), '..')
process.env.ROO_CLI_ROOT = root
process.env.ROO_EXTENSION_PATH = join(root, 'extension')
process.env.ROO_RIPGREP_PATH = join(dirname(executable), 'rg')
let assigned = false
Object.defineProperty(globalThis, '__extensionHost', {
  configurable: true,
  set(host) {
    if (assigned) return
    assigned = true
    const settings = host?.initialSettings
    if (!settings || typeof settings !== 'object') throw new Error('Roo initial settings seam unavailable')
    Object.assign(settings, {
      apiProvider: 'openai',
      openAiModelId: process.env.TALENT_ROO_MODEL,
      openAiBaseUrl: process.env.TALENT_ROO_BASE_URL,
      openAiApiKey: process.env.TALENT_ROO_RELAY_KEY,
      disabledTools: ['browser_action'],
      mcpEnabled: false,
      telemetrySetting: 'disabled',
    })
    Object.defineProperty(globalThis, '__extensionHost', { configurable: true, writable: true, value: host })
  },
})
process.argv = [process.execPath, executable, ...process.argv.slice(3)]
await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
