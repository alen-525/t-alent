# t-alent

[中文项目简要说明](项目说明.md)

t-alent is a neutral agent framework. Agent packages define Harness behavior: execution loops, prompts, tools, context, and session strategy. Models are configured separately and supplied to the selected Harness by the local host. Package code runs in Node, not in the browser. A loaded package and an independently configured model must both be selected to run a task.

## Run

Install dependencies, copy the independent model configuration example, and edit its model IDs and credential environment-variable references for your account:

```sh
npm install
cp config/models.example.json config/models.local.json
npm run dev
```

In another terminal, explicitly load trusted packages, the model file, and a workspace:

```sh
npm run host -- --package ./packs/deepseek --package ./packs/codex --models config/models.local.json --workspace /path/to/workspace
```

Credentials come from the host process environment. The framework does not load `.env` automatically. To use a local `.env` file with Node 26:

```sh
node --env-file=.env packages/runtime/cli.mjs --package ./packs/deepseek --package ./packs/codex --models config/models.local.json --workspace .
```

Copy `.env.example` to `.env` and replace its placeholders. Keep credentials local; model JSON contains variable names, never keys.

## Independent models

The model file belongs to the host, independently of Agent packages:

```json
{
  "models": [
    {
      "id": "my-responses-model",
      "name": "My model",
      "provider": "openai",
      "model": "your-model-id",
      "protocol": "openai-responses",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  ]
}
```

`id` identifies the profile in the UI; `model` is the upstream model ID. `provider` names the provider, `protocol` identifies its adapter, and `apiKeyEnv` refers to a credential in the host environment. Optional `baseUrl` specifies a compatible endpoint. Optional `defaultModelId` explicitly selects a host-configured default profile; without it, the user selects a model. No model file is loaded automatically. Restart the host after changing it.

Choose a Harness and model independently. The model selector and Models page use the host's global registry. Changing packages preserves the selected model; changing either selection starts a new conversation. Selection is locked while a task runs. Incompatible protocols are rejected rather than silently changing the model: the current DeepSeek Harness adapter supports `deepseek`, and Codex supports `openai-responses`. Model names alone do not guarantee protocol, tool support, or account availability.

Migration: move model names, endpoints, and credential references out of package config into the model file. Package model catalogs, package-default selection, and temporary custom-ID input have been removed. Tasks must select a registered profile.

## Harness packages

The DeepSeek package runs the official DSH headless Harness. The Codex package adapts the official App Server and preserves its execution behavior at that boundary. Codex Rust internal module replacement and the general composition SDK remain planned work. Setup and behavior customization: [DeepSeek](packs/deepseek/README.md), [Codex](packs/codex/README.md).

The host listens on `127.0.0.1:8787`; Vite proxies same-origin `/api` requests to it. Repeat `--package` to load multiple packages. Other options include `--port`, `--state-dir`, and `--config`. Harness config is JSON keyed by package ID and contains behavior settings:

```json
{
  "deepseek": { "reasoningEffort": "high" }
}
```

Each package has its own behavior config and state directory. Model settings are supplied per task from the independent registry. Importing a JSON package descriptor in the UI registers metadata only; the host CLI explicitly loads executable code.

Packages are independent npm workspaces and can be distributed separately:

```sh
mkdir -p dist/packages
npm pack --workspace packs/deepseek --pack-destination dist/packages
npm pack --workspace packs/codex --pack-destination dist/packages
```

Install the desired tarballs in a host project, then pass the installed package directories with `--package`, your model file with `--models`, and a workspace with `--workspace`.

## Package contract

`agent-package.json` contains `id`, `name`, `version`, `entry`, and optional `modelProtocols`. The host checks that the entry resolves inside the package before importing it. The entry exports `createAgentPackage({ workspace, stateDir, env, config })`, returning:

```js
executeTask({ taskId, input, sessionId, model }, { signal }) // AsyncIterable<TaskEvent>; model is a required external profile
cancelTask(taskId) // resolves after the task stops
dispose()
```

`GET /api/models` returns the global registry without credentials. The browser submits `modelId` to `POST /api/tasks`; the host resolves the profile and passes it as `model` to the runtime. Packages adapt the profile to their original Harness and do not provide model catalogs or choose package/provider default models.

`sessionId` identifies the UI conversation. Packages map it to upstream state and keep model routes separate. Shared presentation event types live in `apps/web/src/host-adapter.ts`.

The host has no package-name branches or executable fallback. Without a selected loaded package and registered model, tasks remain disabled. It accepts loopback requests, requires same-origin JSON for mutations, and never exposes provider credential values. The user grants workspace access when starting the host; package code is trusted local code.

## Checks

`npm run build` and `npm test` cover the frontend build, runtime contract, host, and package adapters. Host integration tests bind loopback; a sandbox may skip them on `EPERM`, so use an authorized local environment for the full suite. Package `smoke:mock` scripts drive original runtimes against local mock services without paid model calls.

`Reference/` contains local source references and is excluded from the repository.

## License

t-alent uses the [MIT License](LICENSE). Reused DeepSeek UI code retains its [MIT notice](LICENSE.DeepSeek); see [migration notes](apps/web/MIGRATION.md). Montserrat retains its [SIL Open Font License](apps/web/src/Montserrat-OFL.txt). Package dependencies preserve their licenses: [DeepSeek notices](packs/deepseek/THIRD-PARTY-NOTICES.md), [Codex notices](packs/codex/THIRD-PARTY-NOTICES.md).
