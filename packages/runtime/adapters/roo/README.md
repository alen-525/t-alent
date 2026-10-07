# Roo Code Agent package

This package runs the archived official Roo CLI release `cli-v0.1.17` in print/stream mode. Roo retains its own agent loop, built-in coding tools, model handler, and native task history. Runtime setup downloads only the pinned release archive and validates its SHA-256.

On macOS Apple Silicon, install the runtime into the host state directory:

```sh
node packages/runtime/adapters/roo/scripts/setup-runtime.mjs --state-dir /path/to/host-state
```

Use the pack-scoped directory (for the default host, `.talent/roo`). Supply a cached archive with `--archive /path/to/roo-cli-darwin-arm64.tar.gz`; setup applies the same pinned digest and safe-entry validation.

The archive is installed under `roo-runtime/roo-cli-darwin-arm64`. The official tarball contains the CLI bundle but omits several npm dependencies declared by its manifest. This adapter pins those direct versions and links the already-installed adapter dependencies into the private runtime directory; setup fails with a clear message if the adapter package has not been installed. Other systems must supply a compatible matching CLI via `config.program` or `ROO_BIN`. The package validates `--version` and never invokes the upstream install script or searches PATH.

The adapter accepts `openai-chat-completions` profiles. It uses Roo's native OpenAI handler with the exact arbitrary model identifier and a temporary loopback relay to the host endpoint. The real host key stays in the adapter process; Roo receives only a dummy local relay token, and the key environment variable is removed from the CLI environment. The relay rejects requests whose model differs from the host-selected ID. Configuration is injected through a setter on Roo's global extension-host registration immediately before the unchanged extension is activated. Per-profile settings and task history stay in isolated state directories. Browser, MCP, onboarding, and telemetry access are disabled for this headless harness.

Tasks use Roo's NDJSON prompt stream, and a stable UUID derived from the host session and model profile preserves Roo history across invocations. Abort sends SIGINT and escalates to SIGKILL after `cancelGraceMs`. Roo CLI currently emits text and tool-use/result stream events; the adapter maps these to host task events.

Malformed or oversized events terminate the worker within the cancellation grace period. Successful completion follows a zero exit status and atomic session mapping persistence. A tool result without an upstream exit code reports unknown status. The relay redacts any echoed host credential before it enters the native process or its history.

The upstream repository was archived on 2026-05-15. Provenance pins Roo Code commit `3e237e60616a1ea9c0b8477de3a74ba942de7af2`, tag `cli-v0.1.17`, and Apache-2.0. No source changes are applied to the upstream harness.
