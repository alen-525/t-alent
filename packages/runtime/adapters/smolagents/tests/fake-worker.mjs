import { appendFile } from 'node:fs/promises'
let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input.trim())
if (process.env.TALENT_WORKER_RECORD) await appendFile(process.env.TALENT_WORKER_RECORD, JSON.stringify({ request, hasKey: Boolean(process.env.TALENT_SMOLAGENTS_API_KEY) }) + '\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
if (request.input === 'MALFORMED') { process.stdout.write('{bad\n'); setInterval(() => {}, 1000) }
if (request.input === 'OVERSIZED') { process.stdout.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}\n`); setInterval(() => {}, 1000) }
if (request.input === 'NO_TERMINAL') { send({ type: 'session', sessionId: request.hostSessionKey }); process.exit(0) }
if (request.input === 'COMPLETE_NONZERO') { send({ type: 'assistant-complete' }); process.exit(7) }
if (request.input === 'AFTER_TERMINAL') { send({ type: 'assistant-complete' }); send({ type: 'session', sessionId: request.hostSessionKey }); process.exit(0) }
if (request.input === 'UNKNOWN') { send({ type: 'future-event' }); setInterval(() => {}, 1000) }
send({ type: 'session', sessionId: request.hostSessionKey })
if (request.input === 'HANG') {
  process.on('SIGUSR1', () => { send({ type: 'assistant-replace', text: 'late' }); process.exit(0) })
  setInterval(() => {}, 1000)
} else if (request.input === 'FAIL') {
  send({ type: 'error', message: 'provider key mock-secret' })
} else {
  send({ type: 'tool-call', name: 'python_interpreter', callId: '1', input: 'print(read_file("probe.txt"))' })
  send({ type: 'tool-result', name: 'python_interpreter', callId: '1', output: 'native file observation', status: 'success' })
  send({ type: 'assistant-replace', text: 'done' })
  send({ type: 'assistant-complete' })
}
