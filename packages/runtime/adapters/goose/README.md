# Goose Agent package

This package adapts the official Goose CLI Harness to t-alent. It runs the pinned Goose v1.48.0 `goose run --output-format stream-json` command and keeps Goose's own agent loop, developer tools, and SQLite session history. Models are supplied per task by the host registry.

## Install Goose

Install the matching official v1.48.0 CLI into the host's `stateDir` (macOS ARM64):

```sh
node packages/runtime/adapters/goose/scripts/setup-runtime.mjs --state-dir /path/to/host-state
```

The setup script downloads the pinned release archive, verifies its pinned SHA-256 digest, checks `goose --version`, and installs it at `<stateDir>/goose-runtime/goose`. The official v1.48.0 release does not publish a checksum manifest; this package pins the SHA-256 of the official archive. Other platforms can supply a matching v1.48.0 binary through `config.program` or `GOOSE_BIN`. Package startup rejects a missing or mismatched binary and never searches `PATH` or auto-upgrades.

## Model profiles

The package accepts `protocol: "openai-chat-completions"` and maps profile model, API key reference, and optional `baseUrl` to Goose's OpenAI-compatible provider settings. The endpoint root goes to `OPENAI_HOST`; the request path defaults to `v1/chat/completions`. Credentials are passed only in the child environment. Each profile gets a stable, isolated Goose config, data, state, and cache directory beneath `stateDir`; existing user Goose settings and keychain credentials are not used.

```js
const model = {
  id: 'company-model',
  name: 'Company model',
  provider: 'company',
  model: 'my-model-id',
  protocol: 'openai-chat-completions',
  apiKeyEnv: 'COMPANY_MODEL_KEY',
  baseUrl: 'http://127.0.0.1:9000/v1',
}

for await (const event of agent.executeTask({ taskId, input, sessionId, model }, { signal })) {
  // consume TaskEvents
}
```

Goose session names are derived from the host conversation and profile. Reusing both resumes the same upstream history, including when the package is recreated. Switching model, endpoint, or key reference creates a separate history. Cancelling sends SIGINT to the Goose process group, then SIGKILL after `cancelGraceMs` if needed.

## Harness behavior

Tasks run non-interactively with Goose's `developer` built-in extension, `--no-profile`, and `--output-format stream-json`. Event messages are translated to assistant deltas, tool calls/results, reasoning, and harness events. API key values are removed from the subprocess output and emitted task events. Use `config.cancelGraceMs` to set the graceful-stop window.

## Verification

Run `npm --prefix packages/runtime/adapters/goose test`. `npm --prefix packages/runtime/adapters/goose run smoke:mock` uses the actual pinned Goose binary and a local OpenAI-compatible mock; it exercises provider routing, tool execution, session resume, and cancellation without contacting an external model API.

## Source and license

The upstream release is [Goose v1.48.0](https://github.com/aaif-goose/goose/releases/tag/v1.48.0), commit `25021517f12cab87c94bed0874fe7d28168dc264`, under Apache-2.0. The package adapter is MIT licensed.
