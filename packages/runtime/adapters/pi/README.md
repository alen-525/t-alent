# Pi Agent package

This package adapts Pi Coding Agent SDK (`@mariozechner/pi-coding-agent@0.73.1`). Pi owns the agent loop, built-in coding tools, streaming, and session format. The version is pinned for reproducible installs. npm marks this package name deprecated and directs users to the [current package name](https://www.npmjs.com/package/@earendil-works/pi-coding-agent); this adapter currently targets the historical `@mariozechner` release whose source commit and npm artifact are recorded in `agent-sources/pi/0.2.0.json` and `THIRD-PARTY-NOTICES.md`.

Install the package tarball in the host project, then pass its installed directory using `--package`. The host must separately provide a model profile, for example:

```json
{
  "id": "local-openai",
  "provider": "openai",
  "model": "your-model-id",
  "protocol": "openai-chat-completions",
  "apiKeyEnv": "OPENAI_API_KEY",
  "baseUrl": "http://127.0.0.1:8080/v1"
}
```

Supported protocols are `openai-chat-completions`, `openai-responses`, `anthropic`, and `google-generative-ai`. `provider` is a descriptive provider label; the adapter generates an isolated Pi provider key and `model` is the provider's model ID. `apiKeyEnv` names a variable in the host process environment. The key is passed to Pi's in-memory auth storage, rather than saved in an auth file. Native transcripts retain message/tool content, so avoid putting credentials in prompts or model responses. The package rejects model routing in its own config. Keep keys out of model files and package config.

Pi session files and the host-to-session index are stored below this package's `stateDir/pi/`. Session context is keyed by the host `sessionId` and the complete model profile, so changing provider, model, protocol, endpoint, or credential variable starts an isolated Pi session. Session files include conversation and tool history and may contain workspace content; delete `stateDir/pi/` to remove them. Pi's default workspace tools are enabled and run with the permissions of the host process.

Run `npm test` for adapter contract coverage and `npm run smoke:mock` for an end-to-end run through the real Pi SDK against a local mock provider. The smoke test makes no external or paid API call.
