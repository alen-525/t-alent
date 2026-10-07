# OpenAI Symphony assessment (not registered)

Symphony is an issue-tracker orchestration service rather than a standalone coding-agent loop. The current official Elixir reference implementation polls a configured tracker, creates a workspace for each issue, launches Codex in App Server mode, sends it the workflow prompt, and supervises the work. It is therefore a possible orchestration candidate, but its upstream model worker is Codex rather than a direct host-supplied OpenAI-compatible model profile.

## Candidate inspected

- Official repository: [openai/symphony](https://github.com/openai/symphony)
- Fixed release: `v0.0.3`, released 2026-09-15; peeled tag commit `1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb` (tag object `3efccfe499b6b50bdbfb674c4c9603aaa13da06d`; queried from official Git remote on 2026-10-07).
- License: Apache-2.0.
- Official implementation and distribution: Elixir/OTP; upstream publishes Burrito self-contained executables for macOS arm64/x86_64 and Linux arm64/x86_64. The executable embeds Elixir/Erlang and Symphony, but still requires host `codex`, `git`, and tracker credentials.
- Upstream describes Symphony Elixir as prototype software intended for evaluation. The root project describes the tool as an engineering preview for trusted environments.

## Local acceptance status

The official Burrito executable's `--help` invocation passed in the preceding local verification. That confirms the bundled CLI can start and display usage; it does **not** confirm that Symphony can authenticate to a tracker, claim an issue, start a native Codex session, route a request to a host-selected model, receive tool observations, or recover a session. No claim of a locally verified dispatch/model round trip is made here.

The missing evidence is a successful local issue-to-Codex dispatch using a configured tracker and the actual Codex runtime, with the chosen model route and a coding-tool result observed in the next model request. Until that integration is exercised, it is not established that this orchestration service can honor the harness's generic model-profile contract or safely expose an isolated coding session. This is an acceptance gap, not a statement that Symphony is unusable or user-prohibited.

## Primary references

- [v0.0.3 official release](https://github.com/openai/symphony/releases/tag/v0.0.3)
- [Release commit](https://github.com/openai/symphony/commit/1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb)
- [Official Symphony overview and Apache-2.0 license](https://github.com/openai/symphony/tree/1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb)
- [Service specification](https://github.com/openai/symphony/blob/1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb/SPEC.md)
- [Elixir implementation and Burrito requirements](https://github.com/openai/symphony/blob/1c0fb6c8e8ef9031a2c861e62af5f9e66cee39cb/elixir/README.md)
