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

## Clone the reference source

The DeepSeek harness under `Reference/deepseek-harness` is reference material only; it is not a production dependency. Clone this repository with its submodule:

```sh
git clone --recurse-submodules <repository-url>
```

If you already cloned without submodules, initialize it with:

```sh
git submodule update --init --recursive
```
