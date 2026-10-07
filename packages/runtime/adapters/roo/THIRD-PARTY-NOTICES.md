# Third-party notices

## Roo Code CLI

The runtime is the unmodified official `@roo-code/cli` 0.1.17 release archive, `cli-v0.1.17`, from Roo Code commit `3e237e60616a1ea9c0b8477de3a74ba942de7af2`. Its SHA-256 is recorded in `agent-sources/roo/0.2.0.json`. Roo Code is licensed under Apache-2.0; see `LICENSE.roo`.

Roo Code's repository was archived on 2026-05-15. The selected CLI release is a prerelease line; the archive and source commit are pinned so package setup does not track its retired installer or a moving branch.

The release archive omits some packages declared by its bundled `@roo-code/cli` `package.json`. The official manifest at the pinned commit lists `@trpc/client` `^11.8.1`, `commander` `^12.1.0`, `p-wait-for` `^5.0.2`, `react` `^19.1.0`, and `superjson` `^2.2.6`. This adapter pins those direct dependencies to the manifest's lower-bound versions. The repository package lock records resolved package integrity for this install; setup links the installed copies into the extracted CLI. No Roo source or bundled extension files are modified.

## Adapter

The t-alent adapter code is licensed under MIT; see `LICENSE`.
