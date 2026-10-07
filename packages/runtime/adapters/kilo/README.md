# Kilo CLI Agent package

This package delegates the agent loop and tools to the pinned official `@kilocode/cli@7.8.3` runtime. The host supplies the model profile for every task; there is no default model or provider catalog.

```js
const agent = await createAgentPackage({ workspace, stateDir, env: process.env })
try {
  for await (const event of agent.executeTask({ taskId, input, sessionId, model })) console.log(event)
} finally {
  await agent.dispose()
}
```

The adapter uses the documented `kilo run --format json --auto --model ... --dir ...` command, with `--session` when resuming a host conversation. We inspected `packages/opencode/src/cli/cmd/run.ts` at upstream tag `v7.8.3` and ran the published CLI binary: JSON mode writes newline-delimited records with `type`, `timestamp`, and `sessionID`; text and completed tools carry `part`, step markers are `step_start`/`step_finish`, and failures are `error`. Text and tool events are emitted when their parts complete rather than token-by-token. The adapter maps these records to the host event vocabulary.

Each task uses an isolated HOME, XDG config/data/cache directories, and SQLite database. A trusted `KILO_CONFIG_CONTENT` provides the task's explicit model/provider route, disables plugins and MCP servers, and turns telemetry off. The published runtime's config precedence puts `KILO_CONFIG_CONTENT` above project config; the smoke test confirmed that a conflicting project model/provider URL/key/permission does not override the supplied task route. The API key is passed through a private task-only environment variable referenced by the trusted config; the original profile variable and inherited Kilo/OpenCode configuration variables are removed from the child environment. Credentials are redacted from emitted events and process diagnostics. Host session IDs map to Kilo session IDs by a fingerprint of the entire model route, so a route change starts a separate history. Cancellation targets only the child process group owned by this task, escalates from SIGINT after `cancelGraceMs` (default 7 seconds), and early iterator closure cancels that task. `dispose()` cancels any active task owned by this package instance.

The pinned source and published CLI were inspected directly. `kilo run` 7.8.3 has no `--pure` option; the adapter relies on isolated user state and the trusted inline configuration, with plugins and MCP disabled. This is not equivalent to upstream's OpenCode `--pure` switch.

Supported profile protocols follow the upstream bundled provider adapters: `openai-chat-completions`, `openai-responses`, and `anthropic`. They require compatible endpoints; no protocol probing or fallback occurs. `baseUrl` must be credential-free HTTP(S), without query or fragment.

## Validation

`npm --prefix packages/runtime/adapters/kilo test` tests event mapping, routing validation, secret redaction, host session mapping, cancellation, iterator cleanup, and disposal against a local fixture process. These fixture tests are adapter unit tests.

`npm --prefix packages/runtime/adapters/kilo run smoke:mock` launches the installed official Kilo CLI and routes its provider requests to a local mock server. It passed with `@kilocode/cli@7.8.3` on macOS ARM64. It checks all three protocols, conflicting project route config, a native file read/tool return, session reuse across adapter instances, model-route isolation, cancellation/recovery, provider errors, and secret persistence.

## Upstream

CLI package: [`@kilocode/cli@7.8.3`](https://www.npmjs.com/package/@kilocode/cli). Upstream tag: [`v7.8.3`](https://github.com/Kilo-Org/kilocode/tree/v7.8.3), commit `59f1428abb5fe782ee7bd4d258e72a08b74aadb4`. The npm tarball and macOS ARM64 binary package integrity, license, and lock metadata are recorded in `agent-sources/kilo/0.2.0.json`. The npm wrapper selects an OS/architecture-specific optional package; keep optional dependencies enabled when installing. See [third-party notices](THIRD-PARTY-NOTICES.md).
