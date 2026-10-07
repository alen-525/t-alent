# OpenClaw adapter

Runs `openclaw@2026.9.8` through its original `agent --local --json` entry, without a Gateway or channel setup. Node 26.1 or newer is required. `npm install` installs the fixed runtime dependency.

The external host profile selects the exact model, endpoint and credential environment variable. Supported native APIs are Chat Completions, Responses and Anthropic Messages. The selected provider explicitly uses the OpenClaw harness; no model fallbacks are configured. Config files contain an environment SecretRef, not the credential. Native state is isolated by workspace, host conversation and the full model profile. Recreating an adapter preserves the native session.

The CLI emits a final JSON result. The adapter emits the assistant response after native completion; it does not claim token or live tool streaming. Any native tool summary is forwarded as a harness event. Native errors, interrupted runs and malformed results cannot emit a successful completion. Cancellation targets the running process group and permits the next task.

Browser control, UI tools, external messaging, cron, auto update and telemetry are disabled. OpenClaw's coding tools are scoped to the selected workspace, and bootstrap file creation is disabled. Existing workspace instructions still apply. Native shell execution follows OpenClaw's permissions.

Behavior settings: `timeoutSeconds` (1–3600, default 600), `cancelGraceMs` (1–60000, default 3000). Model fields must come from the host profile.

`npm test --workspace @t-alent/adapter-openclaw` checks configuration isolation, credential references, persistent native sessions, errors and cancellation. `npm run smoke:mock --workspace @t-alent/adapter-openclaw` connects the actual fixed runtime to a local model mock and verifies a real native file tool/result, Chat Completions routing, cross-instance history, model route isolation, active-request cancellation/recovery, 401 handling and no credential persistence. Responses and Anthropic routes are configured but are not covered by that smoke test.
