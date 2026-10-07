const args = process.argv.slice(2)
const modelAt = args.indexOf('--model')
const model = args[modelAt + 1]
if (process.env.KILO_TEST_ARGS) {
  const fs = await import('node:fs/promises')
  const configDoc = JSON.parse(process.env.KILO_CONFIG_CONTENT)
  await fs.writeFile(process.env.KILO_TEST_ARGS, JSON.stringify({ args, model, configDoc, db: process.env.KILO_DB }))
}
if (args.at(-1) === 'HANG') {
  process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_cancel' }) + '\n')
  setInterval(() => {}, 1000)
} else if (args.at(-1) === 'FAIL') {
  console.error(`key=${process.env.TALENT_KILO_PROFILE_KEY}`)
  process.exit(2)
} else {
  process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { type: 'text', text: 'answer' } }) + '\n')
  process.stdout.write(JSON.stringify({ type: 'tool_use', sessionID: 'ses_fixture', part: { tool: 'read', state: { input: { path: 'a.txt', credential: 'secret-fixture-key' }, ...(args.at(-1) === 'COMPLETED' ? { status: 'completed', output: 'completed native part secret-fixture-key' } : {}) }, callID: 'tool-1-secret-fixture-key' } }) + '\n')
  if (args.at(-1) !== 'COMPLETED') process.stdout.write(JSON.stringify({ type: 'tool_result', sessionID: 'ses_fixture', part: { tool: 'read', state: { output: 'file text secret-fixture-key' }, callID: 'tool-1-secret-fixture-key' } }) + '\n')
}
