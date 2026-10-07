import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
let input = ''
for await (const chunk of process.stdin) input += chunk
const send = e => process.stdout.write(JSON.stringify(e) + '\n')
const args = process.argv.slice(2)
const record = { args, key: process.env.GEMINI_API_KEY, baseUrl: process.env.GOOGLE_GEMINI_BASE_URL, home: process.env.GEMINI_CLI_HOME, settings: JSON.parse(await readFile(resolve(process.env.GEMINI_CLI_HOME, '.gemini', 'settings.json'), 'utf8')) }
if (process.env.TEST_CAPTURE) await writeFile(process.env.TEST_CAPTURE, JSON.stringify(record))
send({ type: 'init', session_id: args.includes('--resume') ? args[args.indexOf('--resume')+1] : 'gemini-test-session' })
if (input === 'stall') { setInterval(() => {}, 1000) }
else if (input === 'bad') { process.stdout.write('not json\n') }
else if (input === 'error') { send({ type: 'error', severity: 'error', message: `bad ${process.env.GEMINI_API_KEY}` }); send({ type: 'result', status: 'error' }) }
else {
  send({ type: 'tool_use', tool_id: 't1', tool_name: 'read_file', parameters: { file_path: 'hello.txt' } })
  send({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'hello' })
  send({ type: 'message', role: 'assistant', content: `OK ${input}`, delta: true })
  send({ type: 'result', status: 'success', stats: { total_tokens: 4 } })
}
