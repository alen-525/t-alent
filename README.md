# t-alent

A framework-only front end for t-alent. The app provides a conversation shell, package registration and selection UI, appearance preferences, and a typed adapter boundary for a separate execution host.

## Run locally

```sh
npm install
npm run dev
```

Create a production bundle with `npm run build`, check types with `npm run typecheck`, and run host-contract checks with `npm test`.

## Execution boundary

This repository does not include an agent loop, model provider, shell, tool implementation, or code-loading runtime. With no connected host and selected runtime-ready package, task entry is disabled. Importing a JSON package descriptor records validated metadata only; it does not load or execute package code. A host may inject `window.talentHostAdapter` before the app mounts and dispatch `talent:host-ready` when it connects or disconnects. The adapter contract is in `apps/web/src/host-adapter.ts` and streams task events into the UI. See [the migration notes](apps/web/MIGRATION.md).

`Reference/` contains local reference materials and is not included in this repository.
