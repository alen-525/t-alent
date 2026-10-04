#!/usr/bin/env node
import { createHost, parseHostArgs } from './host.mjs'

try {
  const options = parseHostArgs(process.argv.slice(2))
  const host = await createHost({ packagePaths: options.package, workspace: options.workspace, port: options.port, stateDir: options.statedir, configPath: options.config, modelsPath: options.models })
  const address = host.address
  console.log(`t-alent host listening at http://${address.address}:${address.port}; loaded packages: ${host.packages.map(row => row.manifest.id).join(', ') || '(none)'}`)
  let closing
  const shutdown = () => { closing ??= host.close().then(() => process.exit(0)); return closing }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch (error) {
  console.error(`t-alent host: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
