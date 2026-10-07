import { appendFile, writeFile } from 'node:fs/promises'
let text = ''
for await (const chunk of process.stdin) text += chunk
const request = JSON.parse(text.trim())
if (process.env.MINI_SWE_TEST_RECORD) await appendFile(process.env.MINI_SWE_TEST_RECORD, JSON.stringify({ request, key: process.env.OPENAI_API_KEY }) + '\n')
const send = event => process.stdout.write(JSON.stringify(event) + '\n')
send({ type: 'session', sessionId: request.hostSessionKey })
if (request.input === 'NONZERO') { send({type:'assistant-complete'});process.exit(1) }
if (request.input === 'NODONE') { send({type:'assistant-replace',text:'incomplete'});process.exit(0) }
if (request.input === 'MALFORMED') { process.stdout.write('not JSON\n');process.exit(0) }
if (request.input === 'OVERSIZED') { send({type:'assistant-replace',text:'x'.repeat(4*1024*1024+1)});process.exit(0) }
if (request.input === 'HANG') {
  process.on('SIGUSR1', () => { send({ type: 'cancelled' }); process.exit(0) })
  setInterval(() => {}, 1000)
} else if (request.input === 'ERROR') {
  send({ type: 'error', message: `provider failure ${process.env.OPENAI_API_KEY}` })
} else {
  send({ type: 'tool-call', name: 'bash', input: 'cat file.txt', callId: 'tool-call-a' })
  send({ type: 'tool-result', name: 'bash', output: 'fixture tool output', status: 'success', callId: 'tool-call-a' })
  await writeFile(request.trajectoryPath, JSON.stringify({ messages: [{ role: 'assistant', content: 'fixture response' }] }))
  send({ type: 'assistant-replace', text: 'fixture answer' })
  send({ type: 'assistant-complete' })
}
