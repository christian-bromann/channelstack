# Code map

> The one place that says **where each piece of shared logic lives**. Before writing a function, look here. If what you need exists, use it. If it almost exists, extend it. Only create a new module when nothing here fits, and add it to this map in the same PR.
>
> Planned paths are marked *(planned)* until the phase that builds them. The phase review checks that this file matches the code.

## Rules

1. **One owner per concern.** Every row below has exactly one module. Two implementations of the same concern is a blocking review finding.
2. **Drivers don't share code with each other.** Shared behaviour moves into `server/src/core/`. A driver importing from another driver fails `pnpm check:deps`.
3. **Core never imports a driver.** Drivers register themselves with core.
4. **SDK runtimes mirror each other.** The TypeScript, Python and Rust runtimes have the same modules with the same names, so a fix in one is easy to find in the others.
5. **An SDK holds no server code, and the generator reads only the spec.** `pnpm check:deps` enforces both, along with rules 2 and 3 (`.dependency-cruiser.cjs`).

## Server: entry points (`server/src/`)

| Concern | Module | Use it for | Don't |
|---|---|---|---|
| Wiring core and drivers, the control API's own routes, host and path routing | `app.ts` | `createApp`: sessions, status, events, reset, env; mounting each driver's fake | Build services or mount routes anywhere else |
| Listening, the token file, portless names | `serve.ts` | `start`: loopback bind, `server.json`, alias registration | Call `Bun.serve` anywhere else (everything else also runs under Node) |
| The command line | `cli.ts` | `start`, `env`, `secrets rotate`, `--version` | Read `process.argv` or `process.env` flags in core |
| The list of drivers | `drivers/index.ts` | `DRIVERS`, `secretSpecs()` | Import a driver from core |

## Server: core (`server/src/core/`)

| Concern | Module | Use it for | Don't |
|---|---|---|---|
| Sessions and ownership | `sessions/` | Opening and closing scopes, `onClose` cleanup | Track ownership inside a driver |
| Object registry and handles | `registry/` | Typed collections per driver and type; resolving handle ids for a session (`get`), from the platform's side (`find`), and their owner | Keep a private `Map` of objects in a route |
| Ids in each platform's format | `ids/` | Every generated id (`U…`, `C…`, `ts`, GitHub numbers and node ids, UUIDs), seeded by `CHANNELSTACK_SEED`; validating fixed ids (`reserve`) | Call `crypto.randomUUID()` or format ids by hand |
| Secrets | `secrets/` | Fake tokens and signing secrets (the CSPRNG helpers, the token formats, `~/.channelstack/secrets.json`, 0600, rotation); live credentials in memory *(planned, phase 5)* | Generate or store a secret anywhere else |
| Signing and verification | `signing/`, one file per platform, `hmac.ts` shared | HMAC-SHA256 over the sent bytes, constant-time compare (`constantTimeEqual`); the echo signer. Slack v0, `X-Hub-Signature-256`, `Linear-Signature` + `webhookTimestamp`, `X-Notion-Signature` *(planned, with each platform)* | Compute an HMAC or compare a secret in a driver |
| Control API bearer token | `auth/` | Creating the token, parsing `Authorization: Bearer`, the middleware | Compare tokens with `===` |
| Event log and cursors | `events/` | Appending deliveries, API calls and actions (`EventLog`); cursor-based reads of any list (`CursorList`) | Keep per-driver logs or invent another cursor format |
| Delivery queue | `delivery/` | Sending events to the agent over HTTP with the platform's signer and ack window, recording every attempt. Retries, Socket Mode, faults and forged deliveries *(planned, phases 1–2)* | Call `fetch` to the agent from a driver |
| Quiet detector | `quiet/` *(planned, phase 1)* | "Is the agent idle?" for negative and exact-count matchers | Add sleeps or ad-hoc settle timers |
| Reality rules | `reality/` *(planned, phase 5)* | Fake or live per object, `unsupported_in_live`, `fake_actor_in_live_world` | Branch on `process.env` credentials in a driver |
| Safety and cleanup ledger | `safety/`, `ledger/` *(planned, phase 5)* | Live allowlists, tagging, cleanup, `channelstack sweep` | Delete live objects from a driver directly |
| Errors | `errors/` | The protocol's error codes and their HTTP status (`ProtocolError`), including a platform's own refusal surfaced through the control API (`{ platform, status }`) | Throw ad-hoc error shapes from routes |
| Redaction | `redact/` | Scrubbing tokens, secrets and emails from logs and errors (`text`), and tokens from recorded payloads (`tokens`) | Log request bodies or headers without it |
| Logging | `log/` | The one logger: JSON lines, redacted | Write to stdout or stderr from core or a driver |
| Routing helpers | `router/` | `registerRoute`, `DriverRouter`, zod-openapi registration, `x-channelstack-*` extensions; the `Driver`, `DriverContext` and `FakeBackend` contracts | Register Hono routes on the control API without the extensions |
| State directory | `home/` | `CHANNELSTACK_HOME`, writing 0600 files atomically, reading JSON state | Write a file with a secret any other way |
| Time | `clock/` | The injected clock | Call `Date.now()` in core or a driver |
| portless | `portless/` | Registering and removing `*.localhost` names through the `portless` CLI | Spawn `portless` anywhere else |
| Proxy and CA | `proxy/`, `ca/` *(planned, phase 6)* | Host routing to fakes, the name-constrained CA | — |

## Server: drivers (`server/src/drivers/<channel>/`)

Each driver has the same files; see the contract in [architecture.md](architecture.md), section 3.3.

| File | Owns |
|---|---|
| `index.ts` | The driver's definition: its name, the secrets it needs, and how it is built from a `DriverContext` |
| `routes.ts` | Control API routes and schemas for this channel |
| `world.ts` | The `World` interface: each action written once; the channel's record types |
| `fake/` | `api.ts` (the fake provider API), `store.ts` (in-memory state), `world.ts` (the fake `World`), `index.ts` (the `FakeBackend`) |
| `live/` | Real API calls as the app or a person, reads, cleanup handlers *(phase 5)* |
| `payloads.ts` | Builders for every event payload this platform sends (used by the fake's delivery) |
| `transcript.ts` | State → what a person would see |
| `capabilities.ts` | Per action: fake, live, what live needs |

## SDK generator (`codegen/src/`)

| Concern | Module | Notes |
|---|---|---|
| OpenAPI → IR | `ir.ts` | The IR's types and `buildIr`. Refuses a spec no SDK could express (an unbound operation, a body field no method exposes) |
| What every emitter needs | `emit/shared.ts` | Name conversion, `IrIndex` lookups, path templates |
| Emitters | `emit/typescript.ts`, `emit/python.ts` | IR → generated source, as path → contents. Rust in phase 7 |

## SDK runtimes (`sdks/typescript/runtime/`, `sdks/python/channelstack/runtime/`)

The same modules with the same names in every language.

| Concern | Module | Notes |
|---|---|---|
| Transport | `transport` | Bearer token, retries while the server starts, error code → typed exception |
| Launcher | `launcher` | `auto` / `attach` / `start`; finding the server binary and its per-platform package name |
| Client base | `client` | What generated handles share: `HandleContext`, the root client's `close`, the version check on connect |
| Credentials | `credentials` *(planned, phase 5)* | `CHANNELSTACK_<CHANNEL>_*` lookup |
| Waiting and polling | `wait` | The one polling loop: cursor reads, timeouts, quiet checks. Every `waitFor…`, `latest…` and matcher uses it |
| Durations | `duration` | Parsing `"3s"`, `"750ms"` |

The TypeScript SDK's entry is `sdks/typescript/client.ts` (`channelstack/client`), and `sdks/typescript/bin/channelstack.mjs` runs the platform's server binary.

## Scenarios (`scenarios/`)

| Concern | Module | Notes |
|---|---|---|
| Protocol parity scenarios | `smoke/*.yaml` | The format is [decisions/0002-smoke-scenario-format.md](decisions/0002-smoke-scenario-format.md) |
| Running a scenario through an SDK | `runners/typescript/run.ts`, `runners/python/run.py` | One interpreter per language, on the SDK's public API and its `wait` module |
| Reference agents | `agents/` | Plain programs with no channelstack code in them, configured from `channelstack env` |

## Scripts (`scripts/`)

| Concern | Module | Notes |
|---|---|---|
| The gate | `verify-phase.ts` | Standing checks, then the exit checks of phase 0..n |
| Building the spec from the routes; comparing generated files | `lib/generate.ts` | Used by `spec.ts` and `sdk.ts` (write, or `--check`) |
| Build targets and where build output goes | `lib/packages.ts` | The five targets, `binaryPath`, the platform package directories. Package and binary names come from the SDK launcher |
| Running processes | `lib/process.ts` | `run`, `capture`, `background`, `freePort`. Waiting is `waitFor` from the SDK runtime's `wait` module, here too |
| Starting a server executable for a test or a smoke run | `lib/server.ts` | `startBinary`: spawn, wait for the server file, collect output, stop. The SDK launchers have their own start, because they ship |
| The binary under test, with a control API client | `server/test/integration/harness.ts` | `BINARY`, `cli`, `startBinary` (adds `control` to `lib/server.ts`'s). Shared by the server's and the SDK's integration tests |
| Compiling the server | `build-binary.ts` | `bun build --compile`, one npm package per platform |
| Running the server from source | `dev-server.sh` | Stands in for the binary (`CHANNELSTACK_SERVER_BIN`) on machines that block freshly compiled executables. CI never uses it |
| Smoke runs against the binary | `smoke.ts`, `accept.ts` | Server and reference agent next to each SDK's runner; `--repeat` for the flake check |
| Packaging check | `pack-test.ts` | `npm pack` into an empty project |
| Stale-check self-test | `selftest-stale.ts` | Proves `spec:check` and `sdk:check` fail on drift |

## Test integrations (`integrations/`)

| Concern | Module | Notes |
|---|---|---|
| Matcher logic | `integrations/matchers-core/` *(planned, phase 1)* | Framework-neutral matcher implementations built on the SDK's read methods and `wait`. Vitest and Jest adapt it; they don't reimplement matchers |
| Vitest | `integrations/vitest/` *(planned, phase 1)* | Plugin, fixtures, the `expect.extend` adapter |
| Jest | `integrations/jest/` *(planned, phase 7)* | Globals, the `expect.extend` adapter |
| Checks | `integrations/checks/` *(planned, phase 2)* | `slackChecks()` and friends, built on the public API only |
| pytest | `integrations/pytest-channelstack/` *(planned, phase 7)* | Fixtures and assertion helpers |

## Generated code (never edit by hand)

| Path | Generated from |
|---|---|
| `spec/openapi.json`, `spec/ir.json` | The routes (`pnpm spec`) |
| `sdks/typescript/generated/`, `sdks/python/channelstack/generated/` | `spec/ir.json` (`pnpm sdk`) |
