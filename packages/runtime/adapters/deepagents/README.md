# Deep Agents SDK runtime adapter

This package uses the official `deepagents` v0.7.21 Python SDK, calling `create_deep_agent()` and consuming its native LangGraph event stream. It retains Deep Agents' built-in filesystem tool loop and general-purpose subagent. It uses `FilesystemBackend` rooted at the chosen workspace; that backend offers file tools and does not expose shell execution.

Install the pinned runtime with `node packages/runtime/adapters/deepagents/scripts/setup-runtime.mjs --state-dir <private-state> --python <CPython-3.11-or-newer>`. It creates an isolated venv, downloads and verifies pinned wheels for `deepagents`, `langchain-openai`, and `langgraph-checkpoint-sqlite`, then resolves their transitive dependencies into that venv. It never writes to the system Python or shared `node_modules`.

The selected external profile is passed to LangChain's `ChatOpenAI` with the exact model, API base, and selected key from the host environment. A separate SQLite checkpoint database is used for each complete profile fingerprint; a hashed host session ID becomes LangGraph's `thread_id`, so a later adapter instance resumes the same conversation. Neither model credentials nor the host's raw session ID are stored in the database metadata or session map. The native filesystem backend uses virtual paths confined to the selected workspace; shell execution requires a sandbox backend and is not enabled here.

The worker emits NDJSON from the SDK's native `astream_events` stream. Chat model tokens become assistant deltas; SDK tool start/end events become tool call/result events, including delegated subagent tools. A completion event is emitted only after the worker exits successfully. Python and API failures become error events; cancellation terminates the worker process group. No browser or desktop UI is opened.

The SDK is MIT licensed. Adapter code is MIT licensed; see `LICENSE` and `LICENSE.deepagents`.

## Validation

`npm test --workspace packages/runtime/adapters/deepagents` runs fake worker tests for routing, sessions, cancellation, redaction, and failure behavior. `npm run smoke:mock --workspace packages/runtime/adapters/deepagents` invokes the real pinned SDK and local OpenAI-compatible mock API; the model issues SDK `read_file` and `write_file` calls and receives their results before returning a final answer. The smoke also verifies checkpoint restoration, cancellation, and HTTP 401 failure handling.
