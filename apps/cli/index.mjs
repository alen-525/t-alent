#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { createLocalClient } from './client.mjs'
import { parseCliArgs } from './args.mjs'

export const HELP = `t-alent — local coding agent CLI

Usage:
  t-alent [options] [prompt...]
  t-alent exec [options] <prompt...>

Options:
  --package <path>       Load a local agent package (repeatable)
  -C, --workspace <dir>  Workspace directory (default: current directory)
  --models <file>        Explicit model profile registry
  --config <file>        Package configuration JSON
  --state-dir <dir>      Package state directory (default: <workspace>/.talent)
  --harness <id>         Select a loaded package by id
  -m, --model <id>       Select a model profile by id
  --resume <id>          Resume a session id
  --exec                 Run one task and exit; a leading "exec" also enables this mode
  --json                 Emit task events as JSON lines (exec mode only)
  --no-color             Disable terminal colors
  -h, --help             Show this help without loading packages
  -v, --version          Show version

Interactive commands:
  /help                  Show available commands
  /harness <id>          Select a loaded package
  /model <id>            Select a model profile
  /resume <id>           Select a session to resume
  /new                   Start a fresh session
  /clear                 Clear the terminal
  /status                Show current selections
  /quit                  Exit

Examples:
  t-alent --package ./packs/codex --models ./models.json
  t-alent exec --package ./packs/codex --models ./models.json --harness codex -m work "Fix the failing test"
  cat prompt.txt | t-alent exec --package ./packs/codex --models ./models.json --harness codex -m work -
`

export function isDirectRun(metaUrl = import.meta.url, argv = process.argv) {
  if (!argv[1]) return false
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(path.resolve(argv[1])) } catch { return false }
}

async function readStdinPrompt(input) {
  if (input.isTTY) throw new Error('exec with prompt "-" requires non-TTY stdin.')
  let value = ''
  for await (const chunk of input) value += chunk.toString()
  if (!value.trim()) throw new Error('Prompt from stdin must not be empty.')
  return value.trim()
}

export async function runCli({ client, options, input = process.stdin, output = process.stdout, error = process.stderr }) {
  if (!options.exec && !input.isTTY) throw new Error('Interactive mode requires a TTY. Use --exec with a prompt for non-interactive use.')
  if (options.exec) {
    if (!options.resume) {
      if (!options.harness) throw new Error('exec requires an explicit --harness <id>.')
      if (!options.model) throw new Error('exec requires --model <id> or a defaultModelId in the explicit model registry.')
      if (!client.packages.some(row => row.manifest.id === options.harness)) throw new Error(`Unknown loaded harness: ${options.harness}`)
      if (!client.models.some(row => row.id === options.model)) throw new Error(`Unknown model profile: ${options.model}`)
    }
    if (!options.prompt) throw new Error('exec requires a prompt (use "-" to read it from stdin).')
    if (options.prompt === '-') options.prompt = await readStdinPrompt(input)
  }
  const { runCli: runApp } = await import('./app.mjs')
  return await runApp({ client, options: { harness: options.harness, model: options.model, prompt: options.prompt, exec: options.exec, json: options.json, resume: options.resume, color: options.color, workspace: options.workspace, stateDir: options.stateDir, version: options.appVersion }, input, output, error })
}

export async function main(argv = process.argv.slice(2), streams = {}) {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stdout
  const error = streams.error ?? process.stderr
  let client
  let exitCode = 0
  try {
    const options = parseCliArgs(argv)
    if (options.help) { output.write(HELP); return 0 }
    const packageInfo = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    options.appVersion = packageInfo.version
    if (options.version) {
      output.write(`${packageInfo.version}\n`)
      return 0
    }
    if (!options.exec && !input.isTTY) throw new Error('Interactive mode requires a TTY. Use --exec with a prompt for non-interactive use.')
    if (options.exec && !options.resume && (!options.harness || (!options.model && !options.models))) throw new Error('exec requires --harness and --model (or --models with a defaultModelId).')
    if (options.exec && options.prompt === '-' && input.isTTY) throw new Error('exec with prompt "-" requires non-TTY stdin.')
    if (options.exec && !options.prompt && input.isTTY) throw new Error('exec requires a prompt (use "-" to read it from stdin).')
    client = await createLocalClient({ packagePaths: options.packagePaths, workspace: options.workspace, stateDir: options.stateDir, configPath: options.config, modelsPath: options.models })
    if (options.exec && !options.model && client.defaultModelId) options.model = client.defaultModelId
    const result = await runCli({ client, options, input, output, error })
    exitCode = Number.isInteger(result) ? result : 0
  } catch (cause) {
    error.write(`t-alent: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    exitCode = 1
  } finally {
    if (client) {
      try { await client.close() } catch (cause) { error.write(`t-alent: shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}\n`); exitCode = 1 }
    }
  }
  return exitCode
}

if (isDirectRun()) process.exitCode = await main()
