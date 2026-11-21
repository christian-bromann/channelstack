# Code map

> The one place that says **where each piece of shared logic lives**. Before writing a function, look here. If what you need exists, use it. If it almost exists, extend it. Only create a new module when nothing here fits, and add it to this map in the same PR.
>
> Planned paths are marked *(planned)* until the phase that builds them. The phase review checks that this file matches the code.

## Rules

1. **One owner per concern.** Every row below has exactly one module. Two implementations of the same concern is a blocking review finding.
2. **Drivers don't share code with each other.** Shared behaviour moves into `server/src/core/`. A driver importing from another driver fails `pnpm check:deps`.
3. **Core never imports a driver.** Drivers register themselves with core.
4. **SDK runtimes mirror each other.** The TypeScript, Python and Rust runtimes have the same modules with the same names, so a fix in one is easy to find in the others.

## Server: core (`server/src/core/`)

| Concern | Module | Use it for | Don't |
|---|---|---|---|
| Sessions and ownership | `sessions/` *(planned)* | Opening and closing scopes, recording which session owns an object, attributing events | Track ownership inside a driver |
| Object registry and handles | `registry/` *(planned)* | Resolving handle ids from path parameters, typed lookups | Keep a private `Map` of objects in a route |
| Ids in each platform's format | `ids/` *(planned)* | Every generated id (`U…`, `C…`, `ts`, GitHub numbers and node ids, UUIDs), seeded by `CHANNELSTACK_SEED` | Call `crypto.randomUUID()` or format ids by hand |
| Secrets | `secrets/` *(planned)* | Fake tokens and signing secrets (CSPRNG, `~/.channelstack/secrets.json`, 0600), live credentials in memory | Generate or store a secret anywhere else |
| Signing and verification | `signing/` *(planned)*, one file per platform | Slack v0, `X-Hub-Signature-256`, `Linear-Signature` + `webhookTimestamp`, `X-Notion-Signature`; constant-time compare | Compute an HMAC in a driver |
| Event log and cursors | `events/` *(planned)* | Appending deliveries, API calls and actions; cursor-based reads | Keep per-driver logs |
| Delivery queue | `delivery/` *(planned)* | Sending events to the agent over HTTP or Socket Mode, retries, timeouts, ack windows, faults, forged deliveries | Call `fetch` to the agent from a driver |
| Quiet detector | `quiet/` *(planned)* | "Is the agent idle?" for negative and exact-count matchers | Add sleeps or ad-hoc settle timers |
| Reality rules | `reality/` *(planned)* | Fake or live per object, `unsupported_in_live`, `fake_actor_in_live_world` | Branch on `process.env` credentials in a driver |
| Safety and cleanup ledger | `safety/`, `ledger/` *(planned)* | Live allowlists, tagging, cleanup, `channelstack sweep` | Delete live objects from a driver directly |
| Errors | `errors/` *(planned)* | The protocol's error codes and their HTTP mapping | Throw ad-hoc error shapes from routes |
| Redaction | `redact/` *(planned)* | Scrubbing tokens, secrets, emails and names from logs, errors, recordings and the UI | Log request bodies or headers without it |
| Routing helpers | `router/` *(planned)* | `DriverRouter`, zod-openapi registration, `x-channelstack-*` extensions | Register Hono routes without the extensions |
| Proxy and CA | `proxy/`, `ca/` *(planned, phase 6)* | Host routing to fakes, the name-constrained CA | — |

## Server: drivers (`server/src/drivers/<channel>/`)

Each driver has the same files; see the contract in [architecture.md](architecture.md), section 3.3.

| File | Owns |
|---|---|
| `routes.ts` | Control API routes and schemas for this channel |
| `world.ts` | The `World` interface: each action written once |
| `fake/` | The fake provider API and its in-memory store |
| `live/` | Real API calls as the app or a person, reads, cleanup handlers |
| `payloads.ts` | Builders for every event payload this platform sends (used by the fake's delivery) |
| `transcript.ts` | State → what a person would see |
| `capabilities.ts` | Per action: fake, live, what live needs |

## SDK runtimes (`sdks/<lang>/runtime/`)

| Concern | Module | Notes |
|---|---|---|
| Transport | `transport` | Bearer token from `~/.channelstack/server.json`, retries while the server starts, error code → typed exception |
| Launcher | `launcher` | `auto` / `attach` / `start` |
| Credentials | `credentials` | `CHANNELSTACK_<CHANNEL>_*` lookup |
| Waiting and polling | `wait` | The one polling loop: cursor reads, timeouts, quiet checks. Every `waitFor…`, `latest…` and matcher uses it |
| Durations | `duration` | Parsing `"3s"`, `"750ms"` |

## Test integrations (`integrations/`)

| Concern | Module | Notes |
|---|---|---|
| Matcher logic | `integrations/matchers-core/` *(planned)* | Framework-neutral matcher implementations built on the SDK's read methods and `wait`. Vitest and Jest adapt it; they don't reimplement matchers |
| Vitest | `integrations/vitest/` | Plugin, fixtures, the `expect.extend` adapter |
| Jest | `integrations/jest/` | Globals, the `expect.extend` adapter |
| Checks | `integrations/checks/` | `slackChecks()` and friends, built on the public API only |
| pytest | `integrations/pytest-channelstack/` | Fixtures and assertion helpers (phase 7) |

## Generated code (never edit by hand)

| Path | Generated from |
|---|---|
| `spec/openapi.json`, `spec/ir.json` | The routes (`pnpm spec`) |
| `sdks/<lang>/generated/` | `spec/ir.json` (`pnpm sdk`) |
