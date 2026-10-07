# smolagents CodeAgent adapter

This package runs Hugging Face's native `CodeAgent` and `LocalPythonExecutor`. The agent writes Python actions using the upstream code format; the adapter supplies workspace `read_file` and `write_file` tools through the native Tool API, with their paths confined to the task workspace. Browser, web search, and Hub tools are not loaded.

## Install the pinned runtime

The adapter pins the official smolagents 1.26.0 PyPI wheel by SHA-256 and installs it in a private virtual environment below `<stateDir>/smolagents-runtime/venv`. Python 3.10 or newer is required. The official OpenAI SDK extra is installed as a runtime dependency.

```sh
node packages/runtime/adapters/smolagents/scripts/setup-runtime.mjs --state-dir /path/to/private-state --python /path/to/python3
```

The interpreter can also be selected using `TALENT_SMOLAGENTS_PYTHON` or `TALENT_PYTHON`. The setup verifies the smolagents wheel before installation and records the installed runtime details in the private state directory. Task execution checks the pinned smolagents version and the OpenAI SDK import.

## Model profiles

The adapter supports the `openai-chat-completions` protocol through smolagents' official `OpenAIServerModel` export (an alias of `OpenAIModel` in the pinned release). It passes `model` and `baseUrl` directly to the OpenAI SDK without prefixing or rewriting the model identifier. The profile's `provider` value is host metadata. `baseUrl` is optional and defaults to `https://api.openai.com/v1`; an optional display `name` does not affect routing or history identity.

This boundary requires an OpenAI Chat Completions compatible API. It does not add LiteLLM's provider-prefix routing, so providers that require a transformed `provider/model` identifier are unsupported unless their compatible endpoint accepts the host's exact model ID.

```js
const model = {
  id: 'team-model',
  provider: 'gateway-label',
  model: 'model-as-listed-by-host',
  protocol: 'openai-chat-completions',
  apiKeyEnv: 'TEAM_MODEL_KEY',
  baseUrl: 'http://127.0.0.1:9000/v1',
}

for await (const event of agent.executeTask(
  { taskId, sessionId, input: 'Inspect the workspace and report the result.', model },
  { signal },
)) {
  // Consume host TaskEvents.
}
```

The credential is passed only in a private child-process environment variable. It is not included in the worker request, agent model serialization, persisted history, or emitted events. API and worker errors are redacted before they reach the host.

## Native history and execution

Each conversation is isolated by resolved workspace, host session ID, and normalized model profile. The adapter saves each native `RunResult.steps` list and the exact messages produced by the original native memory steps. A later worker restores those messages as memory context and calls `agent.run(..., reset=False)`, allowing the upstream `CodeAgent` to append its native task and action steps. It does not rebuild the ReAct/code-execution loop.

The executor is the official in-process `LocalPythonExecutor`; it is not a security sandbox. It applies upstream best-effort restrictions and authorizes no extra imports. Do not treat it as a boundary for untrusted model output.

## Verification

Run `npm --prefix packages/runtime/adapters/smolagents test` for adapter boundary tests. After installing the pinned runtime, `npm --prefix packages/runtime/adapters/smolagents run smoke:mock` runs the actual upstream CodeAgent against a localhost-only OpenAI-compatible mock. It covers Python action execution, workspace reads/writes, observations in the next model request, native step history across tasks, workspace/profile isolation, cancellation and recovery, provider failure, and credential persistence checks.

## Source and license

Pinned release metadata is in [`agent-sources/smolagents/0.2.0.json`](../../../../agent-sources/smolagents/0.2.0.json). smolagents is Apache-2.0 licensed; see [LICENSE.smolagents](LICENSE.smolagents). The installed OpenAI SDK 3.26.0 is Apache-2.0 licensed; see [LICENSE.openai](LICENSE.openai). The adapter itself is MIT licensed.

History restores native conversation messages and observations. Python executor variables are recreated for each task; this is not a suspended interpreter checkpoint. Native step callbacks emit code and observation events after each step executes.
