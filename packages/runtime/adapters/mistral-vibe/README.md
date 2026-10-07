# Mistral Vibe Agent package

This adapter launches the original Mistral Vibe CLI in its native Agent Client Protocol mode (`vibe-acp`). Vibe owns the agent loop, shell and file tools, and conversation history. The adapter bridges ACP session events and cancellation into Talent Harness events.

Install the isolated Python runtime into the package state directory:

```sh
node packages/runtime/adapters/mistral-vibe/scripts/setup-runtime.mjs \
  --state-dir /path/to/.talent/mistral-vibe \
  --python /path/to/python3.12
```

The setup downloads the platform wheel pinned in the source record, verifies its SHA256, creates a private venv at `stateDir/mistral-vibe-runtime/venv`, installs its declared dependencies, and checks the exact CLI version. Python 3.12 or newer is required.

The host supplies the model profile and its API key. OpenAI-compatible Chat Completions is supported:

```js
const model = {
  id: 'team-model', provider: 'openai-compatible', model: 'chat-model',
  protocol: 'openai-chat-completions', apiKeyEnv: 'TEAM_MODEL_KEY',
  baseUrl: 'http://127.0.0.1:9000/v1',
}
for await (const event of agent.executeTask({ taskId, sessionId, input, model }, { signal })) {
  console.log(event)
}
```

The adapter writes a route-specific Vibe `config.toml` under its private home, with telemetry, update checks, and notifications disabled. It selects Vibe's auto-approve agent for programmatic coding, provides the key through a private synthetic environment variable, removes inherited provider-key variables, sets the browser launcher to a no-op, and redacts known secrets from ACP events/errors. Vibe session IDs are persisted against the workspace, host session ID and complete model route (including profile ID and credential-variable name), then resumed through ACP `session/load`.

`dispose()` and `cancelTask()` affect only this adapter's active ACP child. Version detection also uses an isolated private home. Display names do not alter session identity; omitted base URLs use the standard OpenAI endpoint. Failed tool observations remain available to the native agent to recover from; the ACP turn outcome decides success.

Task cancellation uses Vibe's native `session/cancel`; process termination has a bounded grace period. ACP messages are newline-delimited JSON and each line is limited to 4 MiB.

## Validation

`npm --prefix packages/runtime/adapters/mistral-vibe test` exercises event mapping, session persistence and route isolation, model credential errors, corrupt state rejection, recoverable tool failures, malformed ACP, failure redaction, and cancellation recovery. `npm --prefix packages/runtime/adapters/mistral-vibe run smoke:mock` runs the fixed original Vibe CLI and native `bash` tool against a loopback OpenAI-compatible mock, verifying tool-result return, conversation resume/history, route isolation, cancel/recovery, 401 behavior, and credential non-persistence.

## Upstream

[`mistral-vibe==2.25.8`](https://pypi.org/project/mistral-vibe/2.25.8/) from [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe), Apache-2.0, Python `>=3.12`. See [third-party notices](THIRD-PARTY-NOTICES.md) and the upstream [ACP integration](https://github.com/mistralai/mistral-vibe/tree/v2.25.8/vibe/acp).
