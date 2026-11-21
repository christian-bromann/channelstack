# 0005: Bun's formatter now, its linter once it is stable

Status: accepted, phase 0. Decided by the maintainer.

## Decision

- **Formatting is `bun fmt`.** It is built into Bun, which the project already needs to compile the server. Its settings are in `bunfig.toml` (`[fmt]`: 120 columns, sorted imports) and its ignore list in `.prettierignore`. Hand-written documents, the public contract in `api/` and generated files are not formatted.
- **Lint rules stay with Biome for now, and only lint rules.** `bun lint` exists in Bun's canary build (1.4.6) but not in a stable release. Biome's formatter and import sorting are switched off, so the two tools don't overlap.
- **When a stable Bun ships `bun lint`,** Biome is removed: `pnpm lint` becomes `bun fmt --check && bun lint`, and `@biomejs/biome` and `biome.json` go away.
- **Bun is pinned as a development dependency** (`bun` 1.4.5), so `pnpm` scripts, every machine and CI format and compile with the same version.
- **Type checks stay with `tsc`.** Bun 1.4.5 has `bun check`, but `tsc` also builds the published SDK, so TypeScript stays a dependency either way and one checker is enough.
- **knip, jscpd and dependency-cruiser stay.** They check things Bun doesn't: dead code, copy-paste and architecture boundaries.

## Why

Fewer tools to install, configure and keep in step. A formatter and a linter that come with the runtime can't drift from it.

## Alternatives considered

- **Pin the canary build to use `bun lint` today.** Rejected: the gate would depend on a pre-release.
- **Run without a linter until `bun lint` is stable.** Rejected: the lint rules catch real mistakes in the meantime.
