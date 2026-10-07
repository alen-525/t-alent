# OpenCode Agent package

This package runs the official OpenCode CLI as its Harness. It delegates the agent loop, tools, and durable session history to OpenCode `1.18.32`; it does not implement a second agent loop. The host must pass a complete external model profile on every task.

```js
const agent = await createAgentPackage({ workspace, stateDir, env: process.env })
try {
  for await (const event of agent.executeTask({ taskId, input, sessionId, model })) console.log(event)
} finally {
  await agent.dispose()
}
```

Supported profile protocols in this pinned runtime:

| Protocol | OpenCode provider adapter |
| --- | --- |
| `openai-chat-completions` | `@ai-sdk/openai-compatible` |
| `openai-responses` | `@ai-sdk/openai` |
| `anthropic` | `@ai-sdk/anthropic` |

`baseUrl` may point at a compatible endpoint. When omitted, the protocol's standard OpenAI or Anthropic endpoint is used. The profile's own `provider`, `model`, `apiKeyEnv`, and optional `baseUrl` define the route; the package has no model catalog or default model. Each task writes a temporary private config with a generated provider key, pins that model explicitly, and runs with `--pure`. This keeps OpenCode's unrelated configured providers and plugins out of the route. Since this upstream version's CLI JSON output is completed-part oriented, `assistant-delta` events may arrive in chunks after a part completes rather than token-by-token.

The package assigns an isolated OpenCode home, config, data, cache, and state directory below `stateDir`. Host `sessionId` values are mapped to OpenCode session IDs using a fingerprint of the full model route, so switching model, endpoint, protocol, or credential reference starts a distinct upstream history. The JSONL output carries the session ID and text/tool events; failures become one `error` event. Cancellation sends SIGINT, waits for the child to exit, and escalates to SIGKILL after `cancelGraceMs` (default 7 seconds). Early iterator closure cancels the owned process. API key values are removed from their original environment variable in the child, passed only through a private synthetic env variable, and redacted from emitted events and errors.

`openai-chat-completions` and `openai-responses` have different request contracts and must be selected according to the endpoint. Anthropic profiles require an Anthropic Messages compatible endpoint. No protocol probing or fallback is performed. HTTP(S) `baseUrl` values with credentials, query strings, or fragments are rejected.

## Validation

`npm --prefix packages/runtime/adapters/opencode test` exercises the host contract, routing, persistence, redaction, cancellation, and iterator cleanup. `npm --prefix packages/runtime/adapters/opencode run smoke:mock` runs the pinned official CLI against a local OpenAI-compatible mock endpoint; it does not contact a paid model service.

## Upstream

CLI package: [`opencode-ai@1.18.32`](https://www.npmjs.com/package/opencode-ai). Upstream project: [`anomalyco/opencode`](https://github.com/anomalyco/opencode), tag `v1.18.32`, commit `545f51d26cc39a907d2867492d498d9607ea5fa4`. The CLI wrapper and platform-specific binary were inspected from npm tarballs; the matching macOS ARM64 binary reports version `1.18.32`. See [third-party notices](THIRD-PARTY-NOTICES.md).
