# Open Interpreter adapter

This adapter runs the original Python `OpenInterpreter` chat/code loop from the fixed `open-interpreter==0.4.3` PyPI wheel. It is the legacy Python runtime, not the newer Rust-based Open Interpreter CLI. The package release is pinned by wheel SHA-256; PyPI does not publish a matching source commit/tag for 0.4.3, so the source record leaves those fields null rather than assigning the adjacent v0.4.2 Git tag.

Open Interpreter uses LiteLLM for its model transport. The adapter passes `openai/<profile.model>`, the profile's exact `baseUrl`, and the selected API key from the configured environment variable. The provider string is a host label; `openai-chat-completions` selects the transport. Credentials are never added to argv, the request JSON, or saved history. Inherited provider credentials/endpoints are removed from the worker environment.

The upstream loop executes Python and shell code in the workspace and returns the interpreter's observed console output. Its process history is persisted per host session and complete model-profile fingerprint, so later adapter instances can resume it. The adapter keeps this upstream execution loop and only translates its events to bounded NDJSON.

Browser and desktop integrations are excluded from the model's advertised computer tools and `webbrowser.open` is blocked in the worker. Python/shell code still runs with the host user's permissions and is not a security sandbox. Code execution may modify workspace files or invoke ordinary shell commands as required by the task.

Install its private runtime with `node packages/runtime/adapters/open-interpreter/scripts/setup-runtime.mjs --state-dir <stateDir> [--python <python>]`. With the host's default `.talent` state root, its package state directory is `.talent/open-interpreter`, and the venv is `.talent/open-interpreter/open-interpreter-runtime/venv`. The setup downloads and verifies the Open Interpreter and setuptools wheels before installing them and the upstream declared dependencies. The setuptools pin retains the `pkg_resources` API required by the 2024 runtime. It accepts `--python`, `TALENT_PYTHON`, or a discovered Python 3.9–3.12; it does not use a machine-specific interpreter path.

The upstream wheel includes the complete GNU AGPL v3 license text; see `LICENSE.open-interpreter`. The adapter follows that license because its Python worker imports and integrates the upstream runtime. `THIRD-PARTY-NOTICES.md` records the exact boundary and artifact.

## Validation

Completed turns save the upstream conversation history atomically. Cancelling an active turn stops the upstream process and retains the last fully completed history; partial streamed turns are not checkpointed.

Run `npm test --workspace @t-alent/adapter-open-interpreter` for process/lifecycle tests. Run `npm run smoke:mock --workspace @t-alent/adapter-open-interpreter` after installing the private Python runtime to exercise the actual 0.4.3 loop against an in-process local Chat Completions mock. The smoke accepts `TALENT_OPEN_INTERPRETER_PYTHON` or `OPEN_INTERPRETER_PYTHON` to select another installed runtime.
