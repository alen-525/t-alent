import { appendFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const record = process.env.TALENT_TEST_RECORD
await appendFile(record, `${JSON.stringify({ args, env: { apiKey: process.env.OPENAI_API_KEY, apiBase: process.env.OPENAI_API_BASE, oldEndpoint: process.env.OPENAI_BASE_URL, oldAzureEndpoint: process.env.AZURE_OPENAI_ENDPOINT, oldAiderModel: process.env.AIDER_MODEL, browser: process.env.BROWSER, home: process.env.HOME } })}\n`)
if (process.env.TALENT_TEST_MODE === 'error') {
  process.stderr.write(`provider refused ${process.env.OPENAI_API_KEY}`)
  process.exit(7)
}
if (process.env.TALENT_TEST_MODE === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await writeFile(process.env.TALENT_TEST_PID_FILE, String(child.pid))
  setInterval(() => {}, 1000)
}
process.stdout.write('Aider completed model response\n')
