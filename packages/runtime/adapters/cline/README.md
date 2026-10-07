# Cline Agent package

This package embeds the original `@cline/core@0.0.90` `ClineCore` SDK in local mode. Cline owns its agent loop and default coding tools. The version is fixed; npm's artifact shasum and integrity are recorded in `agent-sources/cline/0.2.0.json` and `THIRD-PARTY-NOTICES.md`.

The host supplies a model profile for each task. Example:

```json
{
  "id": "local-openai",
  "provider": "openai-compatible",
  "model": "mock-model",
  "protocol": "openai-chat-completions",
  "apiKeyEnv": "OPENAI_API_KEY",
  "baseUrl": "http://127.0.0.1:8080/v1"
}
```

This adapter supports `openai-chat-completions` through Cline’s original `openai-compatible` provider. The profile’s `provider` is a descriptive label; `model` is the upstream model ID. The key comes from the host process environment and is passed to Cline's in-memory start configuration. Package config cannot select a model.

The SDK runs in a separate Node worker with an isolated home directory. It uses the original default system prompt and coding tools, with built-in agent teams/spawning disabled. Local SDK mode is experimental upstream. Exact selected-key echoes are filtered before persisting messages/compaction; the raw hook audit is disabled, and host diagnostics are redacted.

The package stores Cline Core session artifacts and a canonical transcript index below `stateDir/cline/`. Follow-up turns seed the original Cline message objects through the SDK's `initialMessages` field. This preserves model-visible conversation/tool history, but starts a fresh Cline Core session for each host task; live approval state and in-flight tool state are not resumed. Changing any route field isolates the transcript. Session artifacts include workspace content; remove `stateDir/cline/` to erase them.

The framework loads this adapter when a declarative Cline recipe is selected. Run `npm test` for contract tests and `npm run smoke:mock` for the original Cline Harness against a local mock provider with no paid API call.

The adapter supplies generic model metadata (200,000 context tokens and 8,192 output tokens), not a model catalog. A compatible endpoint must support streaming tool calls; the protocol alone does not guarantee model capability.
