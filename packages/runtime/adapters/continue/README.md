# Continue native Harness adapter

This framework workspace invokes the original `@continuedev/cli@1.5.47` headless coding loop. The distributed Agent recipe lives at `packs/continue/` and contains only JSON and prompts. The npm source commit is `d3f60ba9dd3fb5bfd3c91d6fbb41ce1aa768db45`; integrity and source provenance are recorded in `agent-sources/continue/0.2.0.json`.

```sh
npm install
npm run cli -- --package ./packs/continue --models config/models.local.json --workspace /path/to/workspace
```

Select the `continue` Harness and an external model. Supported profiles use `openai-chat-completions` or `anthropic`; profile `id`, `provider`, `model`, `protocol`, `apiKeyEnv`, and optional `baseUrl` all come from the host. Provider labels do not choose upstream protocols. The adapter writes a single-model isolated YAML config with an environment-secret reference, never the actual key, and explicitly supplies it with `--config`. No Continue account or cloud model catalog is required.

Behavior config supports `permissions: "readonly" | "auto"` and `cancelGraceMs` (1–60000). Readonly is the default; select auto to permit the native editing and command tools. Example host config:

```json
{ "continue": { "permissions": "auto" } }
```

Each workspace/conversation/model profile has its own Continue home. The original CLI persists native history; repeated tasks resume the latest session in that isolated directory. A changed model, endpoint, credential reference or host session uses a different directory. Cancellation terminates the owned process group and waits for it to stop; disposal prevents additional execution.

Continue's `--format json` asks the model for JSON and is not a native task-event stream. This adapter uses final text output and emits tool messages from the persisted native turn after completion. It does not claim live token/tool streaming. Success requires exit code zero, an actual persisted native session, and nonempty text. Errors and exposed task events redact known credentials; native logs/history can still contain user input and workspace content. The native tools run with the host user's filesystem/process access; an isolated home is not an OS sandbox.

```sh
npm test --workspace packages/runtime/adapters/continue
npm run smoke:mock --workspace packages/runtime/adapters/continue
```

The original runtime smoke test uses a local mock Chat Completions API and proves native Read tool execution/result return, explicit model routing, cross-instance history, conversation isolation, cancellation/recovery and 401 error handling without paid API calls. Anthropic routing is implemented through the published CLI's native provider; its full tool round trip is not yet part of this test.

Official references: [CLI configuration](https://docs.continue.dev/cli/configuration), [pinned source](https://github.com/continuedev/continue/tree/d3f60ba9dd3fb5bfd3c91d6fbb41ce1aa768db45/extensions/cli).
