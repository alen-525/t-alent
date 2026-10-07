import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentPackage } from '../src/index.mjs'

const profile = overrides => ({ id: 'test-profile', provider: 'openai', model: 'mock-model', protocol: 'openai-chat-completions', apiKeyEnv: 'PI_TEST_KEY', ...overrides })

test('requires external model profiles and rejects unsupported protocol and package routing', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pi-contract-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const agent = await createAgentPackage({ workspace: stateDir, stateDir, env: { PI_TEST_KEY: 'test-secret' } })
  assert.throws(() => agent.executeTask({ taskId: 'missing', input: 'hello' }), /model profile is required/)
  assert.throws(() => agent.executeTask({ taskId: 'unsupported', input: 'hello', model: profile({ protocol: 'deepseek' }) }), /unsupported model profile protocol/)
  await agent.dispose()
  await assert.rejects(createAgentPackage({ workspace: stateDir, stateDir: join(stateDir, 'legacy'), config: { model: 'old-model' } }), /must come from the external model profile/)
})

test('requires the mapped key in the provided host environment and rejects execution after dispose', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pi-key-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const agent = await createAgentPackage({ workspace: stateDir, stateDir, env: {} })
  assert.throws(() => agent.executeTask({ taskId: 'missing-key', input: 'hello', model: profile() }), /PI_TEST_KEY is missing/)
  await agent.dispose()
  assert.throws(() => agent.executeTask({ taskId: 'disposed', input: 'hello', model: profile() }), /disposed/)
})

test('pre-aborted tasks finish cancelled without creating a native session', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pi-preabort-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const agent = await createAgentPackage({ workspace: stateDir, stateDir, env: { PI_TEST_KEY: 'test-secret' } })
  const controller = new AbortController(); controller.abort()
  const events = []
  for await (const event of agent.executeTask({ taskId: 'pre', input: 'do not run', model: profile() }, { signal: controller.signal })) events.push(event)
  assert.deepEqual(events, [{ type: 'cancelled' }])
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(join(stateDir, 'pi', 'sessions')), [])
  await agent.dispose()
})
