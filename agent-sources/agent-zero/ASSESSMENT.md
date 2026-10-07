# Agent Zero assessment (not registered)

Agent Zero is a general-purpose open-source agent framework with coding capabilities, but the official release is packaged and run as a Docker application. The current verification host did not have the Docker CLI available, so the original agent could not be launched for a local model/tool/history acceptance run. Docker is an environment limitation here; it was not a user restriction.

## Candidate inspected

- Official repository: [agent0ai/agent-zero](https://github.com/agent0ai/agent-zero)
- Fixed release: `v2.13`, released 2026-09-23; peeled tag commit `e3051fb584b1a36be2b0a0c90606f1c2c2d356ec` (tag object `90f2a79e22d1e39cab6db79cd622422edaf96152`; queried from the official Git remote on 2026-10-07).
- License: MIT.
- Official installation model: Docker image `agent0ai/agent-zero`; the setup guide's run path pulls and starts that image. The release is an integrated framework with a WebUI, APIs, agent execution, and plugin/tool infrastructure rather than a small standalone headless loop.

## Local acceptance status

On 2026-10-07, `docker` was not present on this host's `PATH`. Without the official container runtime, this environment could not start the upstream application or prove a real model request, native coding-tool observation, persisted history, profile isolation, cancellation/recovery, provider failure handling, or secret non-persistence. Those behaviors are unverified; no shim agent loop or alternate non-Docker runner was substituted.

The missing Docker executable is the concrete acceptance blocker. It does not mean the user prohibited Docker, and this assessment does not conclude that Agent Zero cannot be integrated. Revisit the candidate when the official Docker runtime can be started and the native flow can be tested with the host model profile under an isolated test configuration.

## Primary references

- [v2.13 official release](https://github.com/agent0ai/agent-zero/releases/tag/v2.13)
- [Release commit](https://github.com/agent0ai/agent-zero/commit/e3051fb584b1a36be2b0a0c90606f1c2c2d356ec)
- [Official MIT license at the fixed commit](https://github.com/agent0ai/agent-zero/blob/e3051fb584b1a36be2b0a0c90606f1c2c2d356ec/LICENSE)
- [Official Docker installation guide](https://github.com/agent0ai/agent-zero/blob/e3051fb584b1a36be2b0a0c90606f1c2c2d356ec/docs/setup/installation.md)
