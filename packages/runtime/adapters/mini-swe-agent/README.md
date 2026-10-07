# mini-SWE-agent adapter

This adapter delegates task execution to the pinned upstream `mini-swe-agent`
2.4.6 Python distribution. In particular, the official `DefaultAgent.run()`
owns the model/basher loop, `LitellmModel` parses OpenAI function tool calls,
and `LocalEnvironment` runs bash and returns observations. The host adapter
does not reimplement that loop.

The supported external model profile is OpenAI Chat Completions through
LiteLLM's `openai/<model>` route. The host supplies `id`, a `provider` label,
`model`, `protocol: "openai-chat-completions"`, and `apiKeyEnv`.
An optional `baseUrl` selects a compatible endpoint; otherwise the standard OpenAI API URL is used. There is no built-in model or provider credential. The key
is read from the host environment and passed to the Python worker over its
private stdin request; it is never placed in the child environment inherited
by LocalEnvironment's shell. Serialized trajectories and emitted events redact
the key. Workspace commands also receive an isolated HOME/XDG/config
environment, so ambient provider settings do not select a model route.

The upstream `DefaultAgent.run()` resets its message list for each invocation.
To support host sessions, this adapter stores the upstream trajectory per
session and exact model-profile fingerprint, then supplies prior task and bash
history as context to the next native run. Changing the model route starts an
independent history. Cancellation is scoped to this adapter's one active
worker: it signals that worker, kills the process group for an active native
LocalEnvironment command, and permits a later task after the worker exits.

Install the fixed runtime into private state with `npm run setup:runtime
-- --state-dir <state-dir>`. Setup uses `TALENT_PYTHON` or `python3` and lets
the upstream distribution's `Requires-Python (>=3.10)` metadata govern
compatibility. The pinned wheel URL, SHA-256, upstream tag, and license are
recorded in `agent-sources/mini-swe-agent/0.2.0.json`.

Run adapter boundary tests with `npm test`. Run the real upstream smoke with
`npm run smoke:mock`: it uses only a local OpenAI-compatible HTTP mock and the
installed pinned package to verify native bash output reaches a later model
request, persistent same-profile session context, route isolation,
cancellation and recovery, a provider failure, and credential-free stored
state. It does not sign in to a provider or open a browser.
