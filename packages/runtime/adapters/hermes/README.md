# Hermes Agent adapter

This adapter invokes the original Hermes Agent `AIAgent.run_conversation` and its upstream native tool dispatcher. It exposes only Hermes' `terminal` and `file` toolsets for coding work. Browser, gateway, TUI, OAuth, chat channels, and scheduled-task features are not started by the adapter.

Set up the private Python runtime with:

```sh
node packages/runtime/adapters/hermes/scripts/setup-runtime.mjs \
  --state-dir /path/to/.talent/hermes \
  --python /path/to/python3.12
```

Setup downloads the official `v2026.9.14` source archive, verifies its SHA256, extracts it beneath `stateDir/hermes-runtime/source`, and installs the release's declared direct dependencies in `stateDir/hermes-runtime/venv`. The upstream project explicitly does not support pip wheel or sdist installation, so the verified source is imported directly. Python `>=3.11,<3.14` is required. The install includes upstream's declared direct dependencies (including its browser, web-server, document-extraction and scheduling libraries); the adapter does not invoke those unrelated features.

The host supplies a profile using OpenAI-compatible Chat Completions. The profile carries an arbitrary provider label, exact model ID, optional display name, optional standard `baseUrl`, and the name of an environment variable containing the API key. The key is passed only in a private child environment and is redacted from worker events/errors. Each native conversation-history file is scoped to workspace, full routing profile, and host session ID; changing the display name preserves the route identity. Successful native message history is saved atomically. In-progress/cancelled turns do not write a history checkpoint; the prior successful checkpoint remains available for recovery.

```js
const model = {
  id: 'team-model', name: 'Development model', provider: 'self-hosted label',
  model: 'org/model-with/slashes', protocol: 'openai-chat-completions',
  apiKeyEnv: 'TEAM_MODEL_KEY', baseUrl: 'http://127.0.0.1:9000/v1',
}
const agent = await createAgentPackage({ workspace, stateDir, env: process.env })
for await (const event of agent.executeTask({ taskId, sessionId, input, model }, { signal })) {
  console.log(event)
}
```

`dispose()` and `cancelTask()` terminate the active Python worker with a bounded grace period and then kill it if needed. The bridge uses bounded NDJSON records and requires a successful terminal event before reporting completion.

## Validation

`npm --prefix packages/runtime/adapters/hermes test` runs worker-contract, route/session-isolation, redaction, cancellation, malformed-stream, and spawn-failure tests. `npm --prefix packages/runtime/adapters/hermes run smoke:mock` runs the pinned original Hermes loop against a local OpenAI-compatible mock and checks a real native terminal tool call, tool observation reaching the next model request, history across adapter instances, exact slash-bearing IDs, profile isolation, cancel/recovery, HTTP 401 redaction, and key absence from persisted session state.

## Upstream

Official source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), tag `v2026.9.14`, commit `345cd2b057a452236de401d3534b8502a7465e8d`, version `0.21.3`, MIT. Pinned commit-addressed archive URL, SHA256 and Python requirement are recorded in [`agent-sources/hermes/0.2.0.json`](../../../../agent-sources/hermes/0.2.0.json). See [`LICENSE.hermes`](./LICENSE.hermes).
