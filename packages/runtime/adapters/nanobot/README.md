# Nanobot adapter

This adapter uses the official Python SDK from `nanobot-ai==0.3.5` and preserves Nanobot's `Nanobot` SDK, native agent loop and runner, first-party coding tools, and native session storage. It disables Web search/fetch, MCP, CLI apps, image generation, and other non-coding tools, leaving Nanobot's file, search, patch, and shell tools available inside the selected project workspace.

The pinned package is the PyPI sdist (SHA-256 `5d5d92ba163937421c99404ac026dc4723d3b23b83c13a0be3111237401a1dc0`), published as version 0.3.5 by HKUDS/nanobot. The official release notes identify v0.3.5 as the September 15 release. PyPI metadata declares MIT and Python >=3.11. The adapter uses only the SDK and does not invoke Nanobot's TUI, WebUI, gateway, channel clients, or login/update flows.

With the host's package state directory as `<stateDir>`, install the isolated runtime using `node packages/runtime/adapters/nanobot/scripts/setup-runtime.mjs --state-dir <stateDir> [--python <python>]`. The pinned runtime is installed at `<stateDir>/nanobot-runtime/venv`. The script accepts `--python`, `TALENT_PYTHON`, or discovered `python3`/`python` and requires Python 3.11 or newer. It verifies the exact sdist hash before installation.

The host-provided API key is passed to the worker process through its environment and referenced in Nanobot's private profile config by environment-variable name. It is not included in the worker request or profile configuration. Native session data is kept per workspace and complete model-routing profile under `<stateDir>/nanobot/profiles/`.

Nanobot's native shell tool runs with the current user's permissions. Its own shell safeguards remain in effect, and the file tools are restricted to the selected workspace. This is not an OS sandbox.

## Validation

Run `npm test --workspace @t-alent/adapter-nanobot` for adapter process and lifecycle tests. After installing the private runtime, `npm run smoke:mock --workspace @t-alent/adapter-nanobot` exercises the original Python SDK, AgentLoop, coding tools, native sessions, and tool loop against an in-process localhost Chat Completions mock. Set `TALENT_NANOBOT_PYTHON` or `NANOBOT_PYTHON` if the smoke should use a different installed runtime.
