import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const rl = readline.createInterface({ input: process.stdin })
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
let promptId
const sessionId = randomUUID()
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') emit({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } })
  else if (m.method === 'session/new') emit({ jsonrpc: '2.0', id: m.id, result: { sessionId } })
  else if (m.method === 'session/load') emit({ jsonrpc: '2.0', id: m.id, result: { sessionId: m.params.sessionId } })
  else if (m.method === 'session/prompt') {
    promptId = m.id
    if (m.params.prompt[0].text === 'hang') return
    if (m.params.prompt[0].text === 'malformed') { process.stdout.write('{bad ACP JSON}\n'); return }
    if (m.params.prompt[0].text === 'oversized') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x'.repeat(4 * 1024 * 1024 + 12) } } } }) + '\n'); return }
    if (m.params.prompt[0].text === 'provider error') { emit({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `unauthorized ${process.env.TALENT_MISTRAL_VIBE_MODEL_API_KEY}` } }); return }
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal', rawInput: { command: 'cat proof.txt' } } } })
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: m.params.prompt[0].text === 'tool failed' ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: 'native proof' } }] } } })
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } })
    emit({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
  } else if (m.method === 'session/cancel' && promptId) emit({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } })
  else if (m.method === 'initialized') return
})
