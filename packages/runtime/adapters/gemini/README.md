# Gemini CLI Agent package

This package runs the official `@google/gemini-cli@0.62.0` headless Harness. Its original model/tool loop, built-in tools, policies and native persisted conversations remain in the upstream CLI. The adapter translates streaming JSON events into t-alent events; it does not replace the internal loop.

Install from the repository with `npm install`, or install the separately packed npm tarball. Node 22.19 or later is required. Load explicitly:

The `packs/gemini` recipe selects this native adapter through the framework registry.

The external model registry must supply a profile such as:

```json
{
  "id": "my-gemini", "name": "My Gemini profile", "provider": "google",
  "model": "your-gemini-model-id", "protocol": "google-generative-ai",
  "apiKeyEnv": "GEMINI_API_KEY"
}
```

`baseUrl` optionally selects a Generative Language API compatible endpoint; it is mapped to `GOOGLE_GEMINI_BASE_URL`. A profile key is required, even for a custom endpoint. The adapter uses Gemini API-key authentication and never restores Google OAuth or Vertex credentials. Model IDs and account availability depend on the configured service. The package does not define a model catalog or default model. Model routing config in the package is rejected.

State lives under the host-provided `stateDir`: a profile-specific isolated home contains native `.gemini` sessions, and `sessions.json` maps host conversation/profile fingerprints to upstream session IDs. Restarting the host resumes that native history. A changed model, provider, protocol, endpoint or credential reference creates a separate route. Credentials are injected into the child environment rather than config files. Local `.env` loading, telemetry and updates are disabled. Workspace `.gemini/settings.json` is rejected because the upstream merge could override the external model route; workspace instruction files and native tool behavior are still upstream responsibilities.

Behavior config accepts only `approvalMode` (`auto_edit` by default, also `default` or `plan`), `maxSessionTurns` (positive integer), and `cancelGraceMs` (1–60000, default 3000). Requests requiring an interactive approval cannot be answered through the current host contract; the headless CLI applies its own denial behavior. The host grants a trusted workspace; this process adapter does not itself provide OS isolation. On macOS/Linux cancellation terminates the process group, waits, and kills remaining descendants; Windows uses direct child termination. Native streaming tool results sometimes contain an empty display string even though the full result is returned to the model.

```sh
npm --prefix packages/runtime/adapters/gemini test
npm --prefix packages/runtime/adapters/gemini run smoke:mock
```

The smoke starts the actual fixed CLI and a loopback mock API without paid credentials. It checks model/key routing, native `read_file` and its return to the model, native history across package instances, cancellation/recovery, provider failures and credential-free state artifacts. The tests do not establish live service/model availability.

Upstream: [v0.62.0 release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.62.0), [headless protocol](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/docs/cli/headless.md). Apache-2.0 upstream license is retained in `LICENSE.gemini`; adapter code is MIT.
