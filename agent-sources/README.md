# Agent source and adapter versions

The declarative recipes in `packs/<id>/` are distributed at package version `0.2.0`. Each lock record in `<id>/0.2.0.json` records the upstream Agent version separately from the t-alent adapter version; changing a recipe or adapter does not imply an upstream source update. Record a new upstream version only after checking the matching release metadata, npm lock integrity or official release artifact. Preserve source commits, tags, resolved URLs, integrity hashes and license references where locally verified. For Goose, the pinned macOS ARM64 release archive digest is in the record and setup script; the upstream release does not publish a checksum manifest. Cline's published npm artifact does not identify a source commit, so its `referenceCommit` remains `null`.

| Agent | Fixed upstream version | Upstream runtime | License |
|---|---:|---|---|
| codex | 0.159.3 | `@openai/codex` | Apache-2.0 |
| deepseek | 0.2.0-rc.2 | `@deepseek-ai/dsh` | MIT |
| pi | 0.73.1 | `@mariozechner/pi-coding-agent` | MIT |
| opencode | 1.18.32 | `opencode-ai` | MIT |
| gemini | 0.62.0 | `@google/gemini-cli` | Apache-2.0 |
| goose | 1.48.0 | `goose CLI` | Apache-2.0 |
| cline | 0.0.90 | `@cline/core` | Apache-2.0 |
| continue | 1.5.47 | `@continuedev/cli` | Apache-2.0 |
| qwen | 0.24.7 | `@qwen-code/qwen-code` | Apache-2.0 |
| kilo | 7.8.3 | `@kilocode/cli` | MIT |
| aider | 0.86.2 | `aider-chat` | Apache-2.0 |
| openclaw | 2026.9.8 | `openclaw` | MIT |
| openhands | 1.51.0 | `openhands-sdk` | MIT |
| mini-swe-agent | 2.4.6 | `mini-swe-agent` | MIT |
| deepagents | 0.7.21 | `deepagents` | MIT |
| mistral-vibe | 2.25.8 | `mistral-vibe` | Apache-2.0 |
| swe-agent | 1.1.0 | `sweagent` | MIT |
| open-interpreter | 0.4.3 | `open-interpreter` | AGPL-3.0-only |
| roo | 0.1.17 | `@roo-code/cli` | Apache-2.0 |
| nanobot | 0.3.5 | `nanobot-ai` | MIT |
| smolagents | 1.26.0 | `smolagents` | Apache-2.0 |
| magentic-one | 0.7.5 | `autogen-agentchat` | MIT |
| hermes | 0.21.3 | `hermes-agent` | MIT |
| crewai | 1.15.23 | `crewai` | MIT |

Adapter implementation, tests and retained third-party notices live under `packages/runtime/adapters/<id>/`. The distributed recipe archives contain only `agent-package.json` and `prompts/`.

Python runtimes use pinned PyPI or immutable GitHub source distribution URLs and SHA-256 records; their setup scripts install into private virtual environments. Their dependencies are separate from npm package-lock.json. The broader coding/general-purpose Agent scope is tracked in [the catalog](../docs/AGENT-CATALOG.md).
