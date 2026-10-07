import { appendFile } from 'node:fs/promises'
const payload = JSON.parse(await new Promise(resolve => { let s = ''; process.stdin.setEncoding('utf8').on('data', x => s += x).on('end', () => resolve(s)) }))
await appendFile(process.env.FAKE_RECORD, JSON.stringify({ request: payload, envKey: process.env.TALENT_HERMES_API_KEY, alias: process.env.HERMES_TEST_ALIAS, inherited: process.env.OPENAI_API_KEY, browser: process.env.BROWSER }) + '\n')
if (process.env.FAKE_MODE === 'hang') await new Promise(() => setInterval(() => {}, 1000))
if (process.env.FAKE_MODE === 'malformed') process.stdout.write('{broken\n')
else if (process.env.FAKE_MODE === 'oversized') process.stdout.write(JSON.stringify({ type: 'assistant-delta', text: 'x'.repeat(4 * 1024 * 1024 + 4) }) + '\n')
else if (process.env.FAKE_MODE === 'no-complete') process.stdout.write(JSON.stringify({ type: 'session', sessionId: payload.sessionKey }) + '\n')
else if (process.env.FAKE_MODE === 'failure') { process.stdout.write(JSON.stringify({ type: 'error', message: '401 hermes-secret-marker' }) + '\n'); process.exitCode = 1 }
else { process.stdout.write(JSON.stringify({ type: 'session', sessionId: payload.sessionKey }) + '\n'); process.stdout.write(JSON.stringify({ type: 'tool-call', name: 'terminal', input: 'python3 -c ...' }) + '\n'); process.stdout.write(JSON.stringify({ type: 'tool-result', name: 'terminal', output: 'sample hermes-secret-marker' }) + '\n'); process.stdout.write(JSON.stringify({ type: 'complete' }) + '\n') }
