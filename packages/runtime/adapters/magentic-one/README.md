# Magentic-One coding team adapter

This adapter runs Microsoft's original AutoGen `MagenticOneGroupChat` orchestrator with the upstream `MagenticOneCoderAgent` and `CodeExecutorAgent`. It is a coding-focused Magentic-One composition: it deliberately omits WebSurfer and FileSurfer, so this package does not launch a browser or expose web tools. The original orchestration, Coder, executor, team stream, and native team state are all provided by AutoGen 0.7.5.

AutoGen's latest official `autogen-agentchat`/`autogen-ext` release verified for this package is 0.7.5, published September 30, 2025. The project has had no later Python package release as of the source check. Release and verified wheel metadata are in [`agent-sources/magentic-one/0.2.0.json`](../../../../agent-sources/magentic-one/0.2.0.json).

## Install the private runtime

The setup script installs in `<stateDir>/magentic-one-runtime/venv` and checks the SHA-256 of the exact AutoGen 0.7.5 core, AgentChat, and extension wheels plus the OpenAI 3.26.0 SDK wheel. It installs AutoGen's `openai` extra and saves the exact resolved environment to private `runtime.json`. Python 3.10 or newer is required. Use `TALENT_MAGENTIC_ONE_PYTHON`, `TALENT_PYTHON`, or `--python` to select an interpreter.

```sh
node packages/runtime/adapters/magentic-one/scripts/setup-runtime.mjs --state-dir /path/to/private-state --python /path/to/python3
```

## Model profiles

The adapter accepts `openai-chat-completions` and constructs AutoGen's official `OpenAIChatCompletionClient` with the host's exact model ID, base URL, API key, and capability metadata (`family: unknown`). It does not rewrite the model ID from the provider label. `baseUrl` defaults to `https://api.openai.com/v1`; optional profile display names are metadata. Providers requiring a proprietary protocol or provider-prefixed model ID rewriting are outside this adapter's boundary.

The selected key is passed only in a private child environment. It is removed from the worker input and ambient child variables, and redacted from returned events and errors. The native AutoGen `team.save_state()` data is persisted under a profile/workspace/session-specific private path, and a new worker restores it through `team.load_state()` before running the next task.

## Execution and safety boundary

AutoGen's native `LocalCommandLineCodeExecutor` runs generated Python and shell code on the host in the task workspace. It is not a security sandbox. It uses AutoGen's own command sanitization and per-command timeout, but model-generated code should be treated as arbitrary local code. This adapter provides cancellation through AutoGen's native `CancellationToken`, with process-group termination as a host fallback.

No Docker daemon, browser, WebSurfer, FileSurfer, human input handler, OAuth flow, or external messaging tool is configured. The system prompt asks the orchestrator to use the local coding team only.

## Verification

`npm --prefix packages/runtime/adapters/magentic-one test` runs strict NDJSON contract tests. After setup, `npm --prefix packages/runtime/adapters/magentic-one run smoke:mock` uses the pinned original team against a localhost-only OpenAI-compatible mock to verify native orchestration, Coder-to-executor execution, native team save/load, model/workspace isolation, cancellation/recovery, API errors, and credential scans.

The adapter license is MIT. The upstream AutoGen license is reproduced in [LICENSE.autogen](LICENSE.autogen), and the pinned OpenAI SDK license is in [LICENSE.openai](LICENSE.openai); see [third-party notices](THIRD-PARTY-NOTICES.md).
