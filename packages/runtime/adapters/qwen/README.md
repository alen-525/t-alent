# Qwen Code Agent package

This package delegates the agent loop, native tools, and conversation history to the pinned official Qwen Code CLI (`@qwen-code/qwen-code@0.24.7`). The host must supply a complete model profile for every task; no model or credential is bundled.

```js
const agent = await createAgentPackage({ workspace, stateDir, env: process.env })
try {
  for await (const event of agent.executeTask({ taskId, input, sessionId, model })) console.log(event)
} finally { await agent.dispose() }
```

The adapter accepts the `openai-chat-completions` protocol and maps the profile into Qwen Code's `--auth-type openai`, `--model`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL` inputs. `baseUrl` may be an OpenAI-compatible HTTP(S) endpoint; when omitted, the standard OpenAI URL is used. The profile's API key is read only from its declared `apiKeyEnv`. Secrets are removed from unrelated child environment variables and redacted from emitted events and diagnostics.

Qwen Code's `stream-json` output is translated to the Harness event stream, including session IDs, assistant text, tool calls, and tool results. Host session IDs map to upstream IDs by a fingerprint of the full model profile, so changed model routes receive fresh history. Each route receives its own Qwen home below `stateDir`. Abort signals, explicit cancellation, early iterator closure, and `dispose()` terminate only the adapter's active child process.

## Validation

`npm --prefix packages/runtime/adapters/qwen test` exercises the process boundary, profile mapping, stream events, persisted sessions, route isolation, redaction, and cancellation. `npm --prefix packages/runtime/adapters/qwen run smoke:mock` uses the pinned official CLI against a loopback OpenAI-compatible endpoint and never contacts a paid model service.

## Upstream

[`@qwen-code/qwen-code@0.24.7`](https://www.npmjs.com/package/@qwen-code/qwen-code), [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code), Apache-2.0. The pinned tarball URL and integrity are recorded in `agent-sources/qwen/0.2.0.json`. See [third-party notices](THIRD-PARTY-NOTICES.md).
