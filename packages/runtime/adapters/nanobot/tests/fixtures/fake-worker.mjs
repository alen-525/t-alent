import { appendFile } from 'node:fs/promises'

let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
if (process.env.FAKE_RECORD) await appendFile(process.env.FAKE_RECORD, JSON.stringify({ request, envKey: process.env.NANOBOT_HOST_API_KEY, inherited: process.env.ANOTHER_API_KEY, browser: process.env.BROWSER }) + '\n')
const mode = process.env.FAKE_MODE
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
if (mode === 'malformed') { process.stdout.write('{bad}\n'); process.exit(0) }
if (mode === 'oversized') { process.stdout.write(JSON.stringify({ type: 'assistant-delta', text: 'x'.repeat(1024 * 1024 * 5) }) + '\n'); process.exit(0) }
if (mode === 'failure') { process.stdout.write(JSON.stringify({ type: 'error', message: '401 ' + process.env.NANOBOT_HOST_API_KEY }) + '\n'); process.exit(1) }
if (mode === 'no-complete') { process.stdout.write(JSON.stringify({ type: 'assistant-delta', text: 'answer' }) + '\n'); process.exit(0) }
process.stdout.write(JSON.stringify({ type: 'session', sessionId: request.sessionKey }) + '\n')
process.stdout.write(JSON.stringify({ type: 'tool-call', name: 'read_file', input: '{"path":"sample.txt"}', callId: 'native-1' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'tool-result', name: 'read_file', output: 'sample [redacted]', callId: 'native-1', status: 'ok' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'assistant-delta', text: 'done' }) + '\n')
process.stdout.write(JSON.stringify({ type: 'complete' }) + '\n')
