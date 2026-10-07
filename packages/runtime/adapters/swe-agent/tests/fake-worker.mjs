import { appendFile } from 'node:fs/promises'
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input.trim())
if (process.env.TALENT_WORKER_RECORD) await appendFile(process.env.TALENT_WORKER_RECORD, JSON.stringify({ request, key: process.env.OPENAI_API_KEY }) + '\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
if (request.input === 'MALFORMED') { process.stdout.write('{oops\n'); setInterval(() => {}, 1000) }
if (request.input === 'OVERSIZED') { process.stdout.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}\n`); setInterval(() => {}, 1000) }
if (request.input === 'NO_TERMINAL') { send({ type: 'session', sessionId: request.hostSessionKey }); process.exit(0) }
if (request.input === 'COMPLETE_NONZERO') { send({ type: 'assistant-complete' }); process.exit(7) }
if (request.input === 'AFTER_TERMINAL') { send({ type: 'assistant-complete' }); send({ type: 'session', sessionId: request.hostSessionKey }); process.exit(0) }
if (request.input === 'UNKNOWN_EVENT') { send({ type: 'future-event', value: 'unsupported' }); setInterval(() => {}, 1000) }
send({ type: 'session', sessionId: request.hostSessionKey })
if (request.input === 'HANG') {
  process.on('SIGUSR1', () => { send({ type: 'cancelled' }); process.exit(0) })
  setInterval(() => {}, 1000)
} else if (request.input === 'FAIL') {
  send({ type: 'error', message: `upstream failure ${request.apiKey}` })
} else {
  send({ type: 'tool-call', name: 'bash', callId: '1', input: 'cat probe.txt' })
  send({ type: 'tool-result', name: 'bash', callId: '1', output: 'native fixture observation', status: 'success' })
  send({ type: 'assistant-complete' })
}
