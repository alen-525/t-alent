# Aider runtime adapter

This adapter runs the official `aider-chat` v0.86.2 CLI in its own agent loop. It does not reimplement Aider by sending the task directly to a model. The package recipe supports the host's OpenAI Chat Completions profile and LiteLLM's `openai/<model>` route.

Run `node packages/runtime/adapters/aider/scripts/setup-runtime.mjs --state-dir <private-state> --python <CPython-3.10-through-3.12>` once to install the pinned PyPI wheel into `<private-state>/aider-runtime/venv`. The setup verifies the upstream wheel SHA-256 before installation, checks the Python and Aider versions, and never installs into the system Python or shared `node_modules`. Set `TALENT_STATE_DIR`, `TALENT_AIDER_PYTHON`, or `AIDER_BIN` to use the corresponding host settings.

Each invocation uses Aider's `--message-file` single-message workflow, its own chat history file, `--restore-chat-history` on later turns, `--no-auto-commits`, `--no-dirty-commits`, `--yes-always`, and `--no-stream`. Hosts can pass `config.files` to explicitly attach workspace-relative files; the adapter rejects traversal, symlinks, non-files, and files larger than 2 MB. With no files specified, Aider uses its native repository-map workflow. State paths are isolated by the complete model profile and a one-way hash of the host conversation ID. The adapter strips inherited `AIDER_*`, `OPENAI_*`, and credential variables, uses private HOME/XDG/config/env-file paths, then injects only the selected key and endpoint. Keys never appear in argv or persisted state.

Aider v0.86.2 does not emit native structured tool events. The adapter therefore provides stdout as one final `assistant-replace` event after a successful exit, followed by `assistant-complete`; it reports nonzero exits and recognizable LiteLLM/API failures as errors and process cancellation as `cancelled`. Cancellation signals the subprocess process group and escalates after a bounded grace period. First-run release links, update checks, GUI/browser modes, and Playwright are disabled; `BROWSER` is redirected to `/usr/bin/true` to prevent Aider from opening the host browser.

The upstream package is Apache-2.0 licensed. Adapter code is MIT licensed; see `LICENSE` and `LICENSE.aider`.

## Validation

`npm test --workspace packages/runtime/adapters/aider` runs isolated fake-CLI contract tests. `npm run smoke:mock --workspace packages/runtime/adapters/aider` runs the actual pinned Aider CLI against a local OpenAI-compatible mock server and checks a file read/edit, continuation in the same host session, cancellation, and API failure handling.
