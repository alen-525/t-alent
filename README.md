# t-alent

t-alent is a neutral agent framework: its web app supplies the conversation interface and shared task contract, while independently versioned agent packages own model and tool execution. Package code runs in the local Node host, not in the browser. A package is executable only when its local directory is explicitly passed to the host CLI.

## Run the web app and host

Install workspace dependencies once, then run the web app:

```sh
npm install
npm run dev
```

In another terminal, explicitly select the trusted local packages you want to run and a workspace that their tools may access. The two reference packages can be loaded together:

```sh
npm run host -- --package ./packs/deepseek --package ./packs/codex --workspace /path/to/workspace
```

To load a local `.env` file with Node 26, run the host directly:

```sh
node --env-file=.env packages/runtime/cli.mjs --package ./packs/deepseek --package ./packs/codex --workspace .
```

The framework does not load `.env` automatically. Copy `.env.example` to `.env`, replace the placeholder with your key, and keep that file local.

The DeepSeek and Codex packages are separate npm workspaces and can be packed and distributed independently. To make both tarballs:

```sh
mkdir -p dist/packages
npm pack --workspace packs/deepseek --pack-destination dist/packages
npm pack --workspace packs/codex --pack-destination dist/packages
```

Install the desired package tarballs in a host project (both are shown here), then pass their installed directories explicitly:

```sh
npm install ./dist/packages/t-alent-agent-deepseek-0.1.0.tgz ./dist/packages/t-alent-agent-codex-0.1.0.tgz
npm run host -- --package node_modules/@t-alent/agent-deepseek --package node_modules/@t-alent/agent-codex --workspace /path/to/workspace
```

The DeepSeek package uses `DEEPSEEK_API_KEY`. The Codex package reads `CODEX_API_KEY` or `OPENAI_API_KEY`; see the [Codex package README](packs/codex/README.md) for its setup and configuration. Each package receives its own config entry and state directory. `codex.model` is optional; when omitted, the upstream Codex App Server chooses its default model. The framework does not assert a particular current model name.

After selecting a loaded package in the web app, use the model selector beside the message input. The list comes from that package; “Use package default” keeps its configured/default model, and packages may allow a custom model ID. Changing models starts a new conversation, and the selector is locked while a task is running. The chosen model is sent to the package with each task; it is not a browser-only preference. Model availability still depends on the provider account.

The Codex package adapts the official App Server protocol and preserves its upstream execution behavior at that boundary. This provides an original Codex Harness integration; it does not expose arbitrary source-level replacement of modules inside Codex's Rust execution loop. That deeper modularization remains planned work.

The host listens on `127.0.0.1:8787`; Vite proxies same-origin `/api` requests to it. You can load more than one package by repeating `--package`. Other options are `--port 8787`, `--state-dir .talent`, and `--config path/to/packages.json`. Config is JSON keyed by package id, for example:

```json
{
  "deepseek": {
    "model": "deepseek-flash",
    "reasoningEffort": "high"
  }
}
```

Each package owns its configuration shape and gets an isolated state directory under the selected state root. Provider credentials such as `DEEPSEEK_API_KEY`, `CODEX_API_KEY`, and `OPENAI_API_KEY` are read from the host process environment; they are never sent to the browser. Copy `.env.example` as a reminder of the expected variables, then supply the keys needed by the loaded packages in the host process environment.

## Agent package contract

A package directory contains `agent-package.json` with `id`, `name`, `version`, and an `entry` path relative to that directory. The host validates that the resolved entry stays inside the package before importing it. The entry exports `createAgentPackage({ workspace, stateDir, env, config })` and returns a runtime implementing:

```js
executeTask({ taskId, input, sessionId, model }, { signal }) // AsyncIterable<TaskEvent>; model is optional
cancelTask(taskId) // Promise<void>, resolves when that task has stopped
dispose() // Promise<void>
```

A package may also expose `listModels()` returning `{ models: [{ id, name?, description? }], defaultModel?, allowCustomModel? }`. The host serves it through `GET /api/packages/:id/models`. Packages without this optional capability retain their default behavior. `model` is an optional model ID override for one task; omitted means the package chooses its configured/default model.

`sessionId` is the UI conversation id. A package maps it to any provider-specific session id it needs. The shared task event types live in `apps/web/src/host-adapter.ts`. Importing a JSON descriptor into the UI registers display metadata only; it does not activate code. The host CLI is the only package-code loading path.

The host has no package-name branches or built-in fallback. Without a selected, loaded package, tasks remain disabled. It accepts loopback traffic only, requires same-origin JSON for mutations, and does not expose provider environment variables through its API. Workspace access is granted by the user who starts the host; package tools should act only in response to submitted tasks.

## Checks

Run `npm run build`, `npm run typecheck`, `npm run test:runtime`, and `npm run test:pack`. `npm test` combines the runtime and package suites. Runtime HTTP integration tests bind loopback; restricted sandboxes may skip those checks when the OS returns `EPERM`.

`Reference/` contains local reference materials and is not included in this repository.

## License

t-alent is open source under the [MIT License](LICENSE). Reused DeepSeek Harness UI source retains its [upstream MIT notice](LICENSE.DeepSeek); see the [migration notes](apps/web/MIGRATION.md) for attribution. The Montserrat font retains its [SIL Open Font License](apps/web/src/Montserrat-OFL.txt).

Agent packages preserve their own and their dependencies' licenses: [DeepSeek notices](packs/deepseek/THIRD-PARTY-NOTICES.md) and [Codex notices](packs/codex/THIRD-PARTY-NOTICES.md).
