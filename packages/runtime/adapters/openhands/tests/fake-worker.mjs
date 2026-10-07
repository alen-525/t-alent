import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
let request, started = false
rl.on('line', line => {
  const value = JSON.parse(line)
  if (!started) {
    request = value; started = true
    const emit = record => process.stdout.write(`${JSON.stringify(record)}\n`)
    emit({ kind: 'session', sessionId: request.conversationId })
    if (request.input === 'malformed') { process.stdout.write('{bad json}\n'); return }
    if (request.input === 'oversized') { process.stdout.write(JSON.stringify({ kind: 'assistant-delta', text: 'x'.repeat(4 * 1024 * 1024 + 32) }) + '\n'); return }
    if (request.input === 'startup-exit') { process.exit(1); return }
    if (request.input === 'hang') return
    if (request.input === 'failure') { emit({ kind: 'error', message: `bad ${process.env.TALENT_OPENHANDS_MODEL_API_KEY}` }); emit({ kind: 'done', status: 'error' }); process.exit(0); return }
    if (request.input === 'no-done') { emit({ kind: 'assistant-delta', text: 'not complete' }); process.exit(0); return }
    emit({ kind: 'harness-event', event: { eventType: 'fake' } })
    emit({ kind: 'tool-call', name: 'TerminalTool', callId: 'call-1', input: { command: 'cat hello.txt' } })
    emit({ kind: 'tool-result', name: 'TerminalTool', callId: 'call-1', status: 'success', output: 'file proof' })
    emit({ kind: 'assistant-delta', text: 'answer' })
    emit({ kind: 'done', status: 'finished' }); process.exit(0)
  } else if (value.type === 'cancel') { process.stdout.write(`${JSON.stringify({ kind: 'done', status: 'paused', cancelled: true })}\n`); process.exit(0) }
})
