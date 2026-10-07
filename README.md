# t-alent

[中文项目简要说明](项目说明.md)

t-alent is a programmable agent framework. Each Agent package contains one logic JSON file and a directory of prompts. The framework compiles the recipe, applies its model-specific conditions, and runs the selected native Harness adapter. Models are configured separately. A package and an independently configured model must both be explicitly selected to run a task. See the [Agent package guide](docs/AGENT-PACKAGES.md).

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

## Terminal CLI

The terminal frontend uses a Codex CLI-style prompt, compact task output, keyboard selection, and slash commands. It runs the same explicitly loaded Harness packages locally, without starting the web host or Vite:

```sh
npm run cli -- --package ./packs/deepseek --package ./packs/codex \
  --models config/models.local.json --workspace /path/to/workspace
```

Select a loaded package with `/harness` and a configured model with `/model`. Use `/help` for commands and shortcuts. Package and model selection remain independent; no package is implicitly activated. Switching either creates a new conversation. CLI conversations can be resumed from the same state directory.

For a single task in a script, explicitly select both profiles:

```sh
npm run cli -- --package ./packs/codex --models config/models.local.json \
  --workspace . --harness codex --model openai-gpt-6-sol \
  --exec "Explain the structure of this repository"
```

Use `node apps/cli/index.mjs` directly for clean redirected output; `--json` emits task events as NDJSON in exec mode. `npm run cli:all -- --models config/models.local.json --workspace .` explicitly loads all registered packages. See the [CLI guide](docs/CLI.md) for options, cancellation, and session storage. The `t-alent` executable is also available after linking or installing this project as an npm package.

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

The registered packages below are available. Each invokes its fixed upstream runtime; models remain independently supplied by the host. More coding, general-purpose, and multi-agent projects are tracked in the [Agent catalog](docs/AGENT-CATALOG.md).

| Package | Pinned upstream | Model protocols | Setup |
| --- | --- | --- | --- |
| Codex Agent | @openai/codex 0.159.3 | Responses | [Guide](packages/runtime/adapters/codex/README.md) |
| DeepSeek Agent | @deepseek-ai/dsh 0.2.0-rc.2 | DeepSeek | [Guide](packages/runtime/adapters/deepseek/README.md) |
| Pi Agent | @mariozechner/pi-coding-agent 0.73.1 | Chat Completions, Responses, Anthropic, Google Generative AI | [Guide](packages/runtime/adapters/pi/README.md) |
| OpenCode Agent | opencode-ai 1.18.32 | Chat Completions, Anthropic, Responses | [Guide](packages/runtime/adapters/opencode/README.md) |
| Gemini CLI Agent | @google/gemini-cli 0.62.0 | Google Generative AI | [Guide](packages/runtime/adapters/gemini/README.md) |
| Goose Agent | goose CLI 1.48.0 | Chat Completions | [Guide](packages/runtime/adapters/goose/README.md) |
| Cline Agent | @cline/core 0.0.90 | Chat Completions | [Guide](packages/runtime/adapters/cline/README.md) |
| Continue Agent | @continuedev/cli 1.5.47 | Chat Completions, Anthropic | [Guide](packages/runtime/adapters/continue/README.md) |
| Qwen Code Agent | @qwen-code/qwen-code 0.24.7 | Chat Completions | [Guide](packages/runtime/adapters/qwen/README.md) |
| Kilo CLI Agent | @kilocode/cli 7.8.3 | Chat Completions, Anthropic, Responses | [Guide](packages/runtime/adapters/kilo/README.md) |
| Aider Agent | aider-chat 0.86.2 | Chat Completions | [Guide](packages/runtime/adapters/aider/README.md) |
| OpenClaw Agent | openclaw 2026.9.8 | Chat Completions, Responses, Anthropic | [Guide](packages/runtime/adapters/openclaw/README.md) |
| OpenHands Agent | openhands-sdk 1.51.0 | Chat Completions | [Guide](packages/runtime/adapters/openhands/README.md) |
| mini-SWE-agent | mini-swe-agent 2.4.6 | Chat Completions | [Guide](packages/runtime/adapters/mini-swe-agent/README.md) |
| Deep Agents SDK | deepagents 0.7.21 | Chat Completions | [Guide](packages/runtime/adapters/deepagents/README.md) |
| Mistral Vibe Agent | mistral-vibe 2.25.8 | Chat Completions | [Guide](packages/runtime/adapters/mistral-vibe/README.md) |
| SWE-agent | sweagent 1.1.0 | Chat Completions | [Guide](packages/runtime/adapters/swe-agent/README.md) |
| Open Interpreter (Python legacy runtime) | open-interpreter 0.4.3 | Chat Completions | [Guide](packages/runtime/adapters/open-interpreter/README.md) |
| Roo Code Agent | @roo-code/cli 0.1.17 | Chat Completions | [Guide](packages/runtime/adapters/roo/README.md) |
| Nanobot | nanobot-ai 0.3.5 | Chat Completions | [Guide](packages/runtime/adapters/nanobot/README.md) |
| smolagents CodeAgent | smolagents 1.26.0 | Chat Completions | [Guide](packages/runtime/adapters/smolagents/README.md) |
| Magentic-One coding team | autogen-agentchat 0.7.5 | Chat Completions | [Guide](packages/runtime/adapters/magentic-one/README.md) |
| Hermes Agent | hermes-agent 0.21.3 | Chat Completions | [Guide](packages/runtime/adapters/hermes/README.md) |
| CrewAI | crewai + crewai-tools 1.15.23 | Chat Completions | [Guide](packages/runtime/adapters/crewai/README.md) |

The model file example includes Chat Completions and Gemini API profiles with model-ID placeholders: configure these before running. `openai-chat-completions`, `openai-responses`, `anthropic`, and `google-generative-ai` name distinct protocols. Goose and Roo require separately installed fixed CLIs; Python adapters require private runtimes via their setup guides. The other registered adapters obtain upstream runtimes through npm. Each setup command receives the pack-scoped state directory (for example `.talent/hermes`); the host uses `.talent/<package-id>` by default. Use `npm run host:all -- --models config/models.local.json --workspace /path/to/workspace` to explicitly load all registered packages. Selection and compatibility checks remain generic; no package is automatically selected.

Upstream sources, selection rationale, verification scope and limitations are recorded in [the original five-Harness report](docs/HARNESSES.md) and [additional package report](docs/ADDED-AGENTS.md). These adapters preserve behavior at their SDK/CLI boundaries. The general composition SDK and Codex Rust internal module replacement remain planned work.

The host listens on `127.0.0.1:8787`; Vite proxies same-origin `/api` requests to it. Repeat `--package` to load multiple packages. Other options include `--port`, `--state-dir`, and `--config`. Harness config is JSON keyed by package ID and contains behavior settings:

```json
{
  "deepseek": { "reasoningEffort": "high" }
}
```

Each package has its own behavior config and state directory. Importing a JSON descriptor in the UI registers public metadata only; explicit host loading validates and compiles the full recipe. Model settings remain external to the recipe.

Packages are distributed as JSON-and-prompt archives. Native adapter code, dependencies, tests, and licenses live in the framework's `packages/runtime/adapters/` workspaces:

```sh
npm run pack:agents
npm run verify:agents
```

Archives and `SHA256SUMS` are written to `dist/packages/`. Extract the desired archive and pass its `package/` directory with `--package`; the framework supplies the installed adapter dependencies. Package `0.2.0` and upstream Agent versions are independent, recorded in [agent-sources/](agent-sources/README.md).

## Package contract

A package root contains only `agent-package.json` and `prompts/`. Schema v1 declares identity, SemVer version, exact source Agent version, supported model protocols, prompt files, and a `logic` program. Ordered prompt steps support exact protocol/provider/model conditions, followed by one native execution step. Templates compile to JSON IR with fixed variables; package JSON never evaluates JavaScript. Read the complete [authoring and cache guide](docs/AGENT-PACKAGES.md).

Every explicit load validates and hashes source contents. Identical packages reuse compiled templates in memory or from `<state-dir>/cache/agents/`; edits and version changes invalidate them. Per-task rendering performs no prompt-file reads. Cached data contains no credentials or user tasks. Legacy `entry` plugins remain supported for compatibility, and cannot be mixed with schema v1.

The framework adapter contract remains:

```js
executeTask({ taskId, input, sessionId, model }, { signal }) // AsyncIterable<TaskEvent>
cancelTask(taskId) // resolves after the task stops
dispose()
```

`GET /api/models` exposes public model profiles. Tasks submit only `modelId`; the host resolves private credential references and passes the selected profile to the native adapter. Source version mismatches and unsupported protocols fail before execution. New CLI sessions also bind package/source versions and the program fingerprint; changed instructions get separate upstream histories.

No package or model is activated implicitly. The host accepts loopback requests and requires same-origin JSON for mutations. Workspace access is established when starting the host; original Harness permissions and tool loops remain governed by the selected native adapter.

## Checks

Web assets build into `dist/web/` independently of recipe archives in `dist/packages/`. `npm run build` and `npm test` cover the frontend build, runtime contract, host, and package adapters. Host integration tests bind loopback; a sandbox may skip them on `EPERM`, so use an authorized local environment for the full suite. Package `smoke:mock` scripts drive original runtimes against local mock services without paid model calls.

`Reference/` contains local source references and is excluded from the repository.

## License

t-alent uses the [MIT License](LICENSE). Reused DeepSeek UI code retains its [MIT notice](LICENSE.DeepSeek); see [migration notes](apps/web/MIGRATION.md). Montserrat retains its [SIL Open Font License](apps/web/src/Montserrat-OFL.txt). Each framework adapter retains its third-party notice and required license texts; package/source provenance is recorded separately; see the [Harness report](docs/HARNESSES.md).
