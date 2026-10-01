import { appendFile, readFile, writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const flag = name => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1]
if (process.env.PACK_TEST_ARGS_FILE) {
  const patchPaths = args.flatMap((value, index) => value === '--patch' ? [args[index + 1]] : [])
  const patches = await Promise.all(patchPaths.map(path => readFile(path, 'utf8')))
  await writeFile(process.env.PACK_TEST_ARGS_FILE, JSON.stringify({ args, patches }))
}
let input = ''
for await (const chunk of process.stdin) input += chunk
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const sessionId = flag('--session-id') ?? `new-session-${process.pid}`
emit({ type: 'session', sessionId, cwd: process.cwd() })

if (input.includes('cancel-case')) {
  process.on('SIGINT', () => {
    if (process.env.PACK_TEST_SIGNAL_FILE) void appendFile(process.env.PACK_TEST_SIGNAL_FILE, 'SIGINT\n')
    setTimeout(() => {
      emit({ type: 'text', text: 'late after cancellation' })
      emit({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })
      process.exit(0)
    }, 35)
  })
  await new Promise(() => {})
}

if (input.includes('NO_JSON_FAIL')) {
  process.stderr.write(`fatal ${process.env.DEEPSEEK_API_KEY ?? 'no-secret'}\n`)
  process.exitCode = 1
} else if (input.includes('FAIL')) {
  emit({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { code: 'SERVER', message: 'fixture failed never-event-this-secret' } } })
  emit({ type: 'final', text: '' })
  process.stderr.write(`diagnostic contains ${process.env.DEEPSEEK_API_KEY ?? 'no-secret'}\n`)
  process.exitCode = 1
} else if (input.includes('MALFORMED')) {
  process.stdout.write('null\n')
} else {
  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
  emit({ type: 'tool_call', callId: 'call-1', tool: 'read_file', input: { path: 'note.txt' } })
  emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'fixture file contents' })
  emit({ type: 'text', text: 'x'.repeat(8192), truncated: true })
  emit({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })
  emit({ type: 'final', text: 'complete answer' })
}
