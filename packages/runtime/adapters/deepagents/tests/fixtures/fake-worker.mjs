import { appendFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const payload = JSON.parse(raw)
await appendFile(process.env.TALENT_TEST_RECORD, `${JSON.stringify({ payload, env: { key: process.env.CUSTOM_CRED, endpoint: process.env.OPENAI_BASE_URL, inherited: process.env.OPENAI_API_BASE, browser: process.env.BROWSER } })}\n`)
if (process.env.TALENT_TEST_MODE === 'error') {
  process.stdout.write(`${JSON.stringify({ type: 'error', message: `401 unauthorized ${process.env.CUSTOM_CRED}` })}\n`)
  process.exit(1)
}
if (process.env.TALENT_TEST_MODE === 'complete-fail') {
  process.stdout.write(`${JSON.stringify({ type: 'complete' })}\n`)
  process.exit(9)
}
if (process.env.TALENT_TEST_MODE === 'malformed') {
  process.stdout.write(`${JSON.stringify({ type: `unsupported-${process.env.CUSTOM_CRED}`, message: process.env.CUSTOM_CRED })}\n`)
  process.exit(0)
}
if (process.env.TALENT_TEST_MODE === 'leak') {
  process.stdout.write(`${JSON.stringify({ type: 'tool-call', name: `read-${process.env.CUSTOM_CRED}`, input: { value: process.env.CUSTOM_CRED }, callId: process.env.CUSTOM_CRED })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'tool-result', name: 'read_file', output: process.env.CUSTOM_CRED, status: 'success', callId: process.env.CUSTOM_CRED })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'assistant-delta', text: process.env.CUSTOM_CRED })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'complete' })}\n`)
  process.exit(0)
}
if (process.env.TALENT_TEST_MODE === 'hang') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await writeFile(process.env.TALENT_TEST_PID_FILE, String(descendant.pid))
  setInterval(()=>{},1000)
}
process.stdout.write(`${JSON.stringify({ type: 'tool-call', name: 'read_file', input: { file_path: 'sample.txt' }, callId: 'tool-1' })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'tool-result', name: 'read_file', output: 'alpha [redacted]', status: 'success', callId: 'tool-1' })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'assistant-delta', text: 'Edited file.' })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'complete' })}\n`)
