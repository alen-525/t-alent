import { writeFile } from 'node:fs/promises'
let input = ''
for await (const chunk of process.stdin) input += chunk
const args = process.argv.slice(2)
if (process.env.TEST_CAPTURE) await writeFile(process.env.TEST_CAPTURE, JSON.stringify({ args, key: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, modelEnv: process.env.OPENAI_MODEL, home: process.env.HOME }))
const send = event => process.stdout.write(`${JSON.stringify(event)}\n`)
const prompt = args[args.indexOf('--prompt') + 1] ?? input
if (prompt.includes('RETURN_HANG')) { const session_id = 'qwen-session-return'; send({ type: 'system', subtype: 'init', session_id, uuid: 'sys-return' }); setInterval(() => {}, 1000) }
else if (prompt.includes('HANG')) { if (process.env.TEST_CAPTURE) await writeFile(process.env.TEST_CAPTURE, JSON.stringify({ args, key: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, modelEnv: process.env.OPENAI_MODEL, home: process.env.HOME })); setInterval(() => {}, 1000) }
else if (prompt.includes('BAD')) process.stdout.write('not json\n')
else if (prompt.includes('UNKNOWN')) send({ type: 'future_qwen_event' })
else if (prompt.includes('MISSING_TYPE')) send({ subtype: 'success', is_error: false })
else if (prompt.includes('FAIL')) { send({ type: 'error', severity: 'error', message: `secret ${process.env.OPENAI_API_KEY}` }); process.exitCode = 1 }
else {
  const resumed = args.includes('--resume')
  const session_id = resumed ? args[args.indexOf('--resume') + 1] : 'qwen-session-fixture'
  send({ type: 'system', subtype: 'init', session_id, uuid: 'sys-1' })
  send({ type: 'assistant', uuid: 'asst-1', session_id, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { file_path: 'fixture.txt' } }] } })
  send({ type: 'user', uuid: 'user-1', session_id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'fixture contents' }] } })
  send({ type: 'assistant', uuid: 'asst-2', session_id, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `QWEN_OK:${prompt}` }] } })
  if (!prompt.includes('NO_STATUS')) send({ type: 'result', subtype: 'success', uuid: 'result-1', session_id, is_error: false, result: `QWEN_OK:${prompt}` })
}
