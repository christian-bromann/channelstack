# Phase 0 plan

Goal: the spine. The `echo` driver drives the same compiled binary from TypeScript and Python.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 0.1 The control API needs the token | `server/test/integration/control-api.test.ts` (against the compiled binary: 200 with the token, 401 without, connection refused on a non-loopback address) | `server/src/core/auth/`, `server/src/core/errors/`, `server/src/core/router/`, `server/src/app.ts`, `server/src/serve.ts` |
| 0.2 The echo smoke scenario passes in TypeScript and Python | `scenarios/smoke/echo.yaml`, run by `scripts/smoke.ts` through `scenarios/runners/typescript/run.ts` and `scenarios/runners/python/run.py`, against the compiled binary and `scenarios/agents/echo-agent.ts` | `server/src/drivers/echo/`, `server/src/core/{sessions,registry,events,delivery,signing}/`, `codegen/`, `sdks/typescript/`, `sdks/python/` |
| 0.3 Packaging works | `scripts/pack-test.ts` (`npm pack`, install into an empty project, `npx channelstack --version`, the TS smoke scenario), in the CI `packaging` job on `macos-latest` (arm64) and `ubuntu-latest` (x64) | `sdks/typescript/bin/`, `npm/server-<platform>/`, `scripts/build-binary.ts` |
| 0.4 The stale checks catch drift | `scripts/selftest-stale.ts` (changes a route, expects `spec:check` and `sdk:check` to fail, restores the file) | `scripts/spec.ts`, `scripts/sdk.ts` |
| 0.5 Ids look real | `server/src/core/ids/ids.test.ts` (10,000 ids per kind match the pattern, no collisions, same seed gives the same ids) | `server/src/core/ids/`, `server/src/core/clock/` |
| 0.6 Secrets are stored safely | `server/src/core/secrets/secrets.test.ts`, `server/src/core/home/home.test.ts` (mode 0600 for `secrets.json` and `server.json`, `secrets rotate` changes every value) | `server/src/core/secrets/`, `server/src/core/home/`, `server/src/cli.ts` |
| 0.7 The fake store design is locked | `server/src/drivers/echo/fake-backend.test.ts` (the decision exists and names the interface; the echo fake `satisfies FakeBackend`) | `docs/decisions/0001-fake-backend.md`, `server/src/core/router/driver.ts`, `server/src/drivers/echo/fake/` |

Standing checks, all wired into `pnpm verify:phase 0` (`scripts/verify-phase.ts`):

| Check | How |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over `server/`, `codegen/`, `sdks/typescript/`, `scenarios/`, `scripts/`, and `api/` (examples resolved against `api/*.d.ts` until phase 1 turns on `api:check`); pyright over `sdks/python/` |
| `pnpm lint` | Biome (lint and format) for TypeScript; ruff for Python |
| `pnpm test` | Vitest unit tests |
| `pnpm spec:check`, `pnpm sdk:check` | Regenerate in memory from the routes and compare with the committed files |
| `pnpm test:redaction` | `server/test/integration/redaction.test.ts`: drives the binary with known fake secrets and live-shaped tokens, then searches logs, error bodies and the event log |
| `pnpm check:dupes` | jscpd, 15 lines, generated code excluded |
| `pnpm check:deps` | dependency-cruiser with the rules from `docs/code-map.md` |
| `pnpm check:unused` | knip |
| `pnpm test:accept --repeat 3` | In phase 0 the acceptance suite is the smoke scenarios in both SDKs (the `api/examples` suites start in phase 1) |

## Reuse

Nothing is implemented yet, so every concern is new. Each one lands at the path `docs/code-map.md` already names, and the map loses its *(planned)* marker in the same commit.

| Concern | Module | Note |
|---|---|---|
| Sessions and ownership | `server/src/core/sessions/` | From the code map |
| Object registry | `server/src/core/registry/` | From the code map |
| Ids | `server/src/core/ids/` | From the code map. Uses `pure-rand` for the seeded source |
| Secrets | `server/src/core/secrets/` | From the code map. Also owns the token formats and the one CSPRNG helper |
| Signing | `server/src/core/signing/` | From the code map. Phase 0 adds the shared HMAC primitive and the echo signer |
| Event log and cursors | `server/src/core/events/` | From the code map. Minimal: append, cursor reads |
| Delivery queue | `server/src/core/delivery/` | From the code map. Minimal: one signed HTTP attempt with a timeout, recorded in the event log. Platform retry rules come with each platform |
| Errors | `server/src/core/errors/` | From the code map |
| Redaction | `server/src/core/redact/` | From the code map |
| Routing helpers | `server/src/core/router/` | From the code map. Also holds the `Driver` and `FakeBackend` contracts |
| new: `server/src/core/home/` | State directory and 0600 files | Nothing in the map owns `~/.channelstack` itself; `secrets.json` and `server.json` both need the same safe write |
| new: `server/src/core/auth/` | Control API bearer token | The map has no owner for the bearer check; it uses the CSPRNG from `secrets/` and the constant-time compare from `signing/` |
| new: `server/src/core/clock/` | Injected time | Slack `ts` and delivery timestamps must be testable and reproducible |
| new: `server/src/core/log/` | The one logger | Every log line goes through `redact/` |
| new: `server/src/core/portless/` | Registering `*.localhost` aliases | Shells out to the `portless` CLI |
| SDK runtime: transport, launcher, wait, duration | `sdks/<lang>/runtime/` | From the code map. `credentials` waits for phase 5 (live mode), so it isn't dead code now |

Not built in phase 0, on purpose: quiet detector (phase 1), reality rules, safety and ledger (phase 5), proxy and CA (phase 6), live backends, Socket Mode.

## Decisions taken in this phase

Recorded in `docs/decisions/`:

- `0001-fake-backend.md`: the `FakeBackend` interface and store design (exit check 0.7).
- `0002-smoke-scenario-format.md`: the YAML step format for `scenarios/smoke/`, which no spec document defines.
- `0003-echo-driver.md`: the `echo` driver ships in the binary and the generated SDKs as an experimental, internal surface; it is not part of `api/*.d.ts`.
- `0004-state-directory.md`: `CHANNELSTACK_HOME`, and how a private server (`mode: "start"`) avoids overwriting the shared `server.json`.

## New dependencies

Runtime (in the binary or an SDK):

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `hono` | 4.13.19 | HTTP routing (settled in AGENTS.md) | MIT | Yes |
| `@hono/zod-openapi` | 1.6.3 | Routes → OpenAPI (settled in AGENTS.md) | MIT | Yes |
| `zod` | 4.6.7 | Validation; peer of `@hono/zod-openapi` | MIT | Yes |
| `pure-rand` | 8.4.2 | Seeded, reproducible random source for ids | MIT | Yes |
| `httpx` (Python) | pinned in `uv.lock` | HTTP client for the Python SDK (implementation plan 11.3) | BSD-3-Clause | Yes |

Development only:

| Package | Version | Why | License |
|---|---|---|---|
| `typescript` | 7.0.2 | Type checks and the SDK build | Apache-2.0 |
| `vitest` | 5.1.1 | Unit and integration tests | MIT |
| `@biomejs/biome` | 2.6.8 | Lint and format | MIT OR Apache-2.0 |
| `jscpd` | 5.4.3 | `check:dupes` (named in phases.md) | MIT |
| `dependency-cruiser` | 18.8.0 | `check:deps` (named in phases.md) | MIT |
| `knip` | 6.45.1 | `check:unused` (named in phases.md) | ISC |
| `yaml` | 2.9.1 | Parsing smoke scenarios in the TypeScript runner | ISC |
| `@types/node`, `@types/bun` | 26.6.6, 1.4.5 | Types | MIT |
| `pyyaml`, `ruff`, `pyright` (Python) | pinned in `uv.lock` | Scenario parsing, lint, type check | MIT |

`portless` is not a dependency: the server calls the user's installed CLI, and `--no-portless` works without it.

## Docs to update

- `docs/architecture.md` if the server layout changed.
- `docs/decisions/0001-fake-backend.md`.
- `docs/code-map.md` matches the code.

Contradictions fixed in this PR (lower-ranked document changed, per AGENTS.md):

- `docs/architecture.md` 3.3: `Driver.name` is a closed union of the four channels, but phases.md requires an `echo` driver.
- `docs/architecture.md` 5.3 and 7: runtime modules and the repository layout brought in line with `docs/code-map.md` and what phase 0 builds.
- `docs/phases.md` intro: reviews are posted on the PR, not written to disk; the acceptance check runs the smoke scenarios in phase 0.
- `docs/implementation-plan.md` 13: driver files and core module names brought in line with `docs/code-map.md`.
