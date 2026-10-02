# Codex Agent package

This package adapts the official OpenAI Codex App Server to the t-alent agent-package contract. It runs the pinned `@openai/codex` 0.159.3 native executable through its stdio JSON-RPC interface. Codex keeps its own Rust agent loop and built-in tools; this package supplies the host task, session, safety, and event boundary.

## Setup

The monorepo workspace pins `@openai/codex` to 0.159.3. The package resolves the official platform binary installed by that dependency. Set `CODEX_API_KEY` or `OPENAI_API_KEY` in the host's server environment. The key is sent to App Server's `account/login/start` API-key flow; interactive login is disabled. If no API key is available, tasks fail with a clear authentication error.

The package assigns `CODEX_HOME` to `<stateDir>/codex-home`, so config, cache and session state are isolated from the user's global `~/.codex`. A newly created home config uses `cli_auth_credentials_store = "ephemeral"`, keeping the API key out of persisted auth files. Per-package `config.codexConfig` is passed to Codex as a thread config override; it can configure supported Codex settings including MCP servers. `config.model` (or `config.codexConfig.model`) supplies the default task model. A per-task `model` overrides that default on thread start, resume, and turn start. `config.reasoningEffort` configures the default reasoning effort.

`runtime.listModels()` asks the pinned App Server's paginated `model/list` method for its picker catalog. It maps each upstream `model` slug into the package `id` and uses the upstream default unless package config sets a default model. Catalog requests run in a separate App Server process without API-key environment variables, and that process is stopped when the request completes. Catalog failures are surfaced to the host. `allowCustomModel` stays enabled so a caller can enter a model ID absent from the picker; account entitlement and provider availability are determined when a task runs.

Each conversation maps to a persisted Codex thread ID in `<stateDir>/codex-threads.json`, written atomically with mode 0600. Existing mapped threads are resumed. The package runs one task at a time per instance and scopes cancellation to the task ID. A turn uses `approvalPolicy: "never"`, `sandbox: "workspace-write"`, and a turn policy with only the configured workspace writable and network disabled. Approval RPC requests are declined. The adapter does not grant sandbox escalation.

## Explicit input customization

A trusted `.mjs` file inside the workspace can export `transformInput(input, context)`; the returned string becomes the Codex user message. The path is explicitly set with `config.program`, checked to resolve inside the workspace, and imported as workspace code. Copy [`examples/rewrite-task.mjs`](examples/rewrite-task.mjs) into the workspace (or point to `packs/codex/examples/rewrite-task.mjs` when the package is already in the workspace) and set `config.program` to its workspace-relative path. For the host CLI, pass a JSON file with a package-id entry, for example `{"codex":{"program":"program.mjs","reasoningEffort":"high"}}`, using `--config path/to/packages.json`. The model remains optional. The package has been verified with `config.model`, per-task model overrides, `config.reasoningEffort`, `config.codexConfig` model/provider overrides, and `config.program`. This is a concrete input hook; it does not replace Codex's internal agent loop or built-in tools.

## Verification

Run `npm test --workspace packs/codex` for the fake App Server JSON-RPC tests. `npm run smoke:mock --workspace packs/codex` starts the actual pinned Codex App Server against a local mock Responses API, without sending model requests to an external API; all model requests go to its local mock Responses service.

Upstream release metadata: npm package `@openai/codex@0.159.3`; corresponding upstream source tag `rust-v0.159.3`, commit `01fc69f4026735edfdf6789820549727a4867b11`. The package depends on the upstream npm release, which includes the matching platform executable as an optional dependency.
