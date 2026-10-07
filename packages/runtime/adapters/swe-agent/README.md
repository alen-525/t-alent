# SWE-agent adapter

This adapter runs the official SWE-agent `DefaultAgent` and its native action loop, backed by the official SWE-ReX `LocalDeployment`/`LocalRuntime`. Bash actions execute in the task workspace on the local machine. The adapter does not start Docker or invoke a browser, and it routes model requests through a host-supplied OpenAI Chat Completions profile.

## Install the pinned runtime

The runtime uses SWE-agent v1.1.0 from the upstream GitHub source at commit `0f3acafacabc0def8cc76b4e48acb4b6cf302cb9`, plus the SWE-ReX 1.4.0 wheel. The setup script verifies each archive's SHA-256 before installing them in a private virtual environment under `<stateDir>/swe-agent-runtime/venv` and extracts the upstream config, tools, and source license under `source/`.

```sh
node packages/runtime/adapters/swe-agent/scripts/setup-runtime.mjs --state-dir /path/to/private-state --python /path/to/python3.12
```

Python 3.11 or newer is required. The interpreter can also be selected with `TALENT_PYTHON`; the generated virtual environment stays in the supplied state directory. Adapter startup checks both installed distribution versions. It does not install or upgrade packages during task execution.

## Model profile and task execution

The host must provide a profile for every task. The protocol selects the OpenAI-compatible LiteLLM route; the profile's `provider` label is retained as host metadata. `baseUrl` is optional and defaults to `https://api.openai.com/v1`. API key values are read from the named environment variable, passed only to the worker process, and redacted from emitted events and saved trajectory history. Profile identity, endpoint, model, and key-variable reference all participate in history isolation. The host conversation session ID and workspace are included in the history scope, independently of arbitrary task IDs. An optional display `name` is accepted without affecting routing or history identity.

```js
const model = {
  id: 'team-model',
  provider: 'openai',
  model: 'my-model-id',
  protocol: 'openai-chat-completions',
  apiKeyEnv: 'TEAM_MODEL_KEY',
  baseUrl: 'http://127.0.0.1:9000/v1',
}

for await (const event of agent.executeTask(
  { taskId, sessionId, input: 'Inspect and fix the failing test.', model },
  { signal },
)) {
  // Consume the host TaskEvents stream.
}
```

Each task runs in its own worker process while retaining SWE-agent's native prompt, parser, model loop, bash tool, and SWE-ReX observations. The adapter maps upstream hooks to host events, stores native trajectory context below the private state directory, and terminates the worker and its process group on cancellation. `config.stepLimit`, `config.costLimit`, and `config.cancelGraceMs` control the corresponding upstream limits and graceful cancellation window.

Each native `DefaultAgent.run()` starts a new run. Subsequent host turns include the last five native trajectories (up to 25 steps each, capped at 80,000 characters) as prior context; this is not a paused SDK checkpoint. Native submitted or voluntary exit outcomes complete the turn; limit/error outcomes are reported as errors. Bash observations do not expose a stable process exit code through these hooks, so tool-result status is `unknown`.

## Verification

Run `npm --prefix packages/runtime/adapters/swe-agent test` for adapter boundary tests. After installing the pinned runtime, `npm --prefix packages/runtime/adapters/swe-agent run smoke:mock` exercises the actual upstream agent against a local OpenAI-compatible mock server, including bash output returning to the model, session history, model-profile isolation, cancellation and recovery, provider failure, and credential persistence checks. No external model API is contacted.

## Source and licenses

The immutable source archive and its SHA-256 are recorded in [`agent-sources/swe-agent/0.2.0.json`](../../../../agent-sources/swe-agent/0.2.0.json). SWE-agent and SWE-ReX are both MIT licensed; see [LICENSE.swe-agent](LICENSE.swe-agent) and [LICENSE.swe-rex](LICENSE.swe-rex). The adapter package is MIT licensed.
