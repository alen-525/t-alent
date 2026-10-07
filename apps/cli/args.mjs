import path from 'node:path'

export function parseCliArgs(argv, { cwd = process.cwd() } = {}) {
  const options = { packagePaths: [], workspace: path.resolve(cwd), exec: false, json: false, color: true, prompt: undefined }
  let positional = false
  let firstCommand = true
  const addPromptPart = value => { options._promptParts ??= []; options._promptParts.push(value) }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (positional) { addPromptPart(arg); continue }
    if (firstCommand && arg === 'exec') { options.exec = true; firstCommand = false; continue }
    firstCommand = false
    if (arg === '--') { positional = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--version' || arg === '-v') { options.version = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--no-color') { options.color = false; continue }
    if (arg === '--exec') { options.exec = true; continue }
    if (arg === '-C' || arg === '--workspace' || arg === '--package' || arg === '--models' || arg === '--config' || arg === '--state-dir' || arg === '--harness' || arg === '--model' || arg === '-m' || arg === '--resume') {
      const value = argv[++i]
      if (value === undefined || value === '' || value === '--' || value.startsWith('-')) throw new Error(`${arg} requires a value.`)
      if (arg === '--package') options.packagePaths.push(value)
      else if (arg === '-C' || arg === '--workspace') options.workspace = path.resolve(cwd, value)
      else if (arg === '--models') options.models = value
      else if (arg === '--config') options.config = value
      else if (arg === '--state-dir') options.stateDir = path.resolve(cwd, value)
      else if (arg === '--harness') options.harness = value
      else if (arg === '--model' || arg === '-m') options.model = value
      else options.resume = value
      continue
    }
    if (arg.startsWith('-') && arg !== '-') { throw new Error(`Unknown option: ${arg}`) }
    addPromptPart(arg)
  }
  if (options._promptParts?.length) options.prompt = options._promptParts.join(' ')
  delete options._promptParts
  options.stateDir ??= path.resolve(options.workspace, '.talent')
  if (options.json && !options.exec) throw new Error('--json is only supported with --exec.')
  return options
}
