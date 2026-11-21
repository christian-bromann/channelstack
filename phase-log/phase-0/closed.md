# Phase 0 closed

Pull request: [christian-bromann/channelstack#3](https://github.com/christian-bromann/channelstack/pull/3), squash-merged as `cf8320d` on 2026-11-21 and tagged `phase-0-done`.

## What was built

- **Server spine:** Bun + Hono + `@hono/zod-openapi`; sessions as scopes in one shared world; the control API behind a bearer token, on loopback only; `GET /status`, sessions, the event log with cursors, reset and env.
- **Core services:** ids in every platform's format from a seeded source, CSPRNG secrets in `secrets.json` (0600) with rotation, signing, the delivery queue, redaction, the object registry, portless registration and `--no-portless`.
- **The `echo` driver** over the `FakeBackend` contract (decision 0001), through the full pipeline: control route, world, store, signed delivery, provider API, event log.
- **SDK generation:** routes → OpenAPI with `x-channelstack-*` extensions → IR → TypeScript and Python emitters, with a hand-written runtime per language (transport, launcher, client, wait, duration).
- **Packaging:** `bun build --compile` for five targets, `@channelstack/server-<platform>` packages, and the `channelstack` command that runs the platform's binary.
- **The gate:** `pnpm verify:phase 0` with every standing check, and CI on linux-x64 and darwin-arm64.

## The gate

All four CI jobs passed on the merged head `2015052`: `verify:phase (linux-x64)`, `packaging (darwin-arm64)`, `packaging (linux-x64)` and `compile all five targets`. Exit checks 0.1 to 0.7 each have a test; phase-log/phase-0/plan.md maps them.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 14 (1 blocking, 9 should-fix, 4 nits) | All fixed |
| 2 | changes required | 6 (3 should-fix, 3 nits) | All fixed |
| 3 | not finished | — | The maintainer merged while round 3 was running |

There is no "Verdict: approved" review on the PR: the maintainer merged it directly. Every thread from rounds 1 and 2 is resolved.

## Decisions

docs/decisions/0001 (fake backend), 0002 (smoke scenario format), 0003 (echo driver), 0004 (state directory), 0005 (formatter and linter).

## Deferred

Nothing was deferred to an issue. Open points handed to phase 1:

- **Vitest versions.** `api/` is type-checked against Vitest 3.2, the version the contract names; the repository's own tests run on Vitest 5.1, where the `TestContext` augmentation in `api/vitest.d.ts` doesn't apply.
- **`bun lint`.** Biome stays for lint rules until a stable Bun ships its linter (decision 0005).
- **portless** is exercised with a stand-in executable, not the real proxy.
- **This file and the status table** were added in phase 1's pull request, because the merge came first.
