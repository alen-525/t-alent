# Codex Agent package

This package adapts the pinned OpenAI Codex App Server to the t-alent agent-package contract. Codex keeps its Rust agent loop, built-in tools, and thread persistence. The package supplies the Harness boundary; the host's trusted model registry supplies a complete profile for each task.

## Setup and model profiles

The package runs the official `@openai/codex` 0.159.3 executable and assigns `CODEX_HOME` to `<stateDir>/codex-home`. A task requires a profile such as:

```js
const model = {
  id: 'openai-codex',
  name: 'OpenAI Codex',
  provider: 'openai',
  model: 'your-model-id',
  protocol: 'openai-responses',
  apiKeyEnv: 'OPENAI_API_KEY',
}

for await (const event of agent.executeTask({ taskId, input, sessionId, model })) {
  // consume TaskEvents
}
```

The package accepts `protocol: 'openai-responses'`. With `provider: 'openai'` and no `baseUrl`, the original App Server uses its official OpenAI route and API-key login flow. For a custom Responses-compatible endpoint, include `baseUrl`; the package creates an isolated Codex provider route with the profile model, endpoint, `responses` wire protocol, and `env_key` mapped from the profile's `apiKeyEnv`. The endpoint must be HTTP(S) and contain no embedded credentials, query, or fragment. Codex provider settings and model IDs have Codex-specific compatibility requirements; this package does not claim that arbitrary model APIs or protocols work with Codex.

The host must resolve and validate profiles independently, then pass the profile object as `executeTask({ model })`. Missing profiles, missing referenced environment variables, malformed profiles, and unsupported protocols fail before spawning the App Server. The `apiKeyEnv` value is read from the host process environment and mapped to the child environment key expected by Codex; the key is never inserted into thread configuration or events. Existing `CODEX_API_KEY` and `OPENAI_API_KEY` values do not silently take priority over the profile reference.

Migrate by moving model ID, provider, protocol, optional endpoint, and key environment reference out of package config into the host model registry. Remove `config.model` and `config.codexConfig.model`, `model_provider`, or `model_providers`; these are rejected. The package no longer exports `listModels()` or queries Codex model catalogs, so picker data belongs to the host registry. Other `codexConfig` entries can continue to configure supported non-model Codex settings, and `config.reasoningEffort`, `config.instructions`, `config.program`, and `config.cancelGraceMs` remain Harness behavior settings.

Each stored thread mapping is keyed by host session and a fingerprint of the external profile and model. The same session can therefore keep history for a stable profile while a different provider, endpoint, key reference, or model starts a separate Codex thread.

## Harness behavior

The package runs one task at a time per instance and scopes cancellation to the task ID. A turn uses `approvalPolicy: "never"`, `sandbox: "workspace-write"`, and a turn policy with only the configured workspace writable and network disabled. Codex permission requests are declined. A trusted `.mjs` file inside the workspace can export `transformInput(input, context)`; configure it with `config.program`. This input hook does not replace Codex's internal agent loop or built-in tools.

## Verification

Run `npm --prefix packages/runtime/adapters/codex test` for fake App Server JSON-RPC coverage. `npm --prefix packages/runtime/adapters/codex run smoke:mock` starts the actual pinned App Server against a local mock Responses API, checks the external model route and profile-key Authorization header, exercises tool execution, history, cancellation, and provider errors, and sends no requests to external model APIs.

Upstream release metadata: npm package `@openai/codex@0.159.3`; corresponding upstream source tag `rust-v0.159.3`, commit `01fc69f4026735edfdf6789820549727a4867b11`. The package depends on the upstream npm release, which includes the matching platform executable as an optional dependency.
