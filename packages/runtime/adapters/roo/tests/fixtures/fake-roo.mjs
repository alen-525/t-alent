import { writeFile } from 'node:fs/promises'
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const request = JSON.parse(raw), mode = request.prompt
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
if (process.env.ROO_RECORD_PATH) await writeFile(process.env.ROO_RECORD_PATH, JSON.stringify(process.env))
if (mode === 'MALFORMED') { process.on('SIGTERM', () => {}); process.stdout.write('{bad json}\n'); setInterval(() => {}, 1000) }
else if (mode === 'OVERSIZED') { process.on('SIGTERM', () => {}); process.stdout.write('中'.repeat(1_500_000)); setInterval(() => {}, 1000) }
else if (mode === 'NO_TERMINAL') emit({ type: 'assistant', content: 'still incomplete' })
else if (mode === 'NONZERO') { emit({ type: 'result', success: true }); process.exitCode = 7 }
else if (mode === 'HANG') { process.on('SIGINT', () => {}); setInterval(() => {}, 1000) }
else {
  if (mode === 'RELAY') {
    const url = process.env.TALENT_ROO_BASE_URL + '/chat/completions'
    const model = process.env.TALENT_ROO_MODEL
    const fetchBody = (token, modelId) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ model: modelId, messages: [] }) })
    const unauthorized = await fetchBody('incorrect-token', model)
    const mismatch = await fetchBody(process.env.TALENT_ROO_RELAY_KEY, 'different-model')
    const good = await fetchBody(process.env.TALENT_ROO_RELAY_KEY, model)
    const response = await good.text()
    await writeFile(process.env.HOME + '/native-provider-result.txt', response)
    emit({ type: 'tool_result', output: JSON.stringify({ unauthorized: unauthorized.status, mismatch: mismatch.status, response }) })
  }
  emit({ type: 'result', success: true, content: 'done' })
}
