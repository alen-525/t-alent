# OpenHands Agent package

This package runs the original OpenHands Software Agent SDK loop through `Agent`, `Conversation`, and the SDK's local workspace. It uses the pinned `openhands-sdk==1.51.0` and `openhands-tools==1.51.0` PyPI wheels, including native terminal, file editor, and task tracker tools. It does not substitute a legacy OpenHands CLI.

The package needs Python 3.12 or newer. Install the private runtime into the host state directory:

```sh
node packages/runtime/adapters/openhands/scripts/setup-runtime.mjs \
  --state-dir /path/to/.talent/openhands \
  --python /path/to/python3.12
```

The setup downloads the two pinned official wheels, checks their SHA256 digests, creates a private venv at `stateDir/openhands-runtime/venv`, and installs their declared dependencies there. It uses `TALENT_PYTHON` or `python3` from `PATH` by default; pass `--python` to select another Python 3.12+ interpreter.

The host must provide a complete `openai-chat-completions` model profile for every task:

```js
const model = {
  id: 'team-chat', provider: 'openai-compatible', model: 'chat-model',
  protocol: 'openai-chat-completions', apiKeyEnv: 'TEAM_MODEL_KEY',
  baseUrl: 'http://127.0.0.1:9000/v1',
}
for await (const event of agent.executeTask({ taskId, input, sessionId, model }, { signal })) {
  console.log(event)
}
```

OpenHands receives the model as LiteLLM's `openai/<model>` Chat Completions route. API credentials enter the Python worker through a private synthetic environment variable and are wrapped as `SecretStr`; their values are redacted from task events and errors. Existing OpenHands, LiteLLM, OpenAI, and generic credential environment variables are removed from the worker. Each route has a separate OpenHands home, event store, and deterministic conversation ID. Reusing the host session ID and route resumes OpenHands' persisted conversation, including tool events.

The NDJSON worker forwards original SDK events while mapping assistant messages and native actions/observations into Harness text and tool events. Cancellation calls the SDK's `Conversation.interrupt()`, persists the paused conversation, and terminates the worker after the configured grace period if needed. `dispose()` and early iterator closure target only this adapter's active worker.

## Validation

`npm --prefix packages/runtime/adapters/openhands test` covers profile validation, NDJSON mapping, history isolation, errors, credential redaction, startup cancellation, and cleanup. `npm --prefix packages/runtime/adapters/openhands run smoke:mock` runs the pinned SDK and native shell/file tools against a loopback OpenAI-compatible mock, checking tool result return, persisted history, cancellation, and provider authentication failure without contacting a hosted model service.

## Upstream

[`openhands-sdk==1.51.0`](https://pypi.org/project/openhands-sdk/1.51.0/) and [`openhands-tools==1.51.0`](https://pypi.org/project/openhands-tools/1.51.0/) from [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk). Both wheels require Python `>=3.12` and use MIT. See [third-party notices](THIRD-PARTY-NOTICES.md).
