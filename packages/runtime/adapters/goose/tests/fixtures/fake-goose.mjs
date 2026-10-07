import { appendFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const argsFile = process.env.TALENT_TEST_ARGS_FILE
if (argsFile) await appendFile(argsFile, `${JSON.stringify({ args, env: {
  configDir: process.env.GOOSE_CONFIG_DIR,
  model: process.env.GOOSE_MODEL,
  provider: process.env.GOOSE_PROVIDER,
  host: process.env.OPENAI_HOST,
  path: process.env.OPENAI_BASE_PATH,
  key: process.env.OPENAI_API_KEY,
  xdg: process.env.XDG_CONFIG_HOME,
} })}\n`)

if (process.env.TALENT_TEST_MODE === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  if (process.env.TALENT_TEST_PID_FILE) await writeFile(process.env.TALENT_TEST_PID_FILE, `${grandchild.pid}`)
  process.on('SIGINT', () => {})
  setInterval(() => {}, 1000)
} else if (process.env.TALENT_TEST_MODE === 'error') {
  process.stdout.write(`${JSON.stringify({ type: 'error', error: `bad key ${process.env.OPENAI_API_KEY}` })}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `hello ${process.env.OPENAI_API_KEY}` }] } })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolRequest', id: 'call-1', toolCall: { value: { name: 'developer__shell', arguments: { command: `printf ${process.env.OPENAI_API_KEY}` } } } }] } })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolResponse', id: 'call-1', content: 'workspace' }] } })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hello test-key ok' }] } })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'complete', total_tokens: 9 })}\n`)
}
