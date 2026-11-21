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
| Wiring core and drivers, the control API's own routes, host and path routing | `app.ts` | `createApp`: sessions, status, events, quiet, reset, env; mounting each driver's fake; serving the UI page and its login link | Build services or mount routes anywhere else |
| Listening, the token file, portless names | `serve.ts` | `start`: loopback bind, `server.json`, alias registration | Call `Bun.serve` anywhere else (everything else also runs under Node) |
| The command line | `cli.ts` | Parsing arguments and dispatching: `start`, `secrets rotate`, `--version`, and the attach commands below | Read `process.argv` or `process.env` flags in core |
| Attaching to a running server | `cli/attach.ts` | Finding the server (`--server`, `CHANNELSTACK_URL`, `server.json`), calling the control API, the shared `dev` session, `CliError` | Read `server.json` or call the control API from another CLI module |
| Acting from the terminal | `cli/slack.ts` | `slack say`, `reply`, `react`; people and channels by name, created on first use; what `last` means | Resolve names or `last` anywhere else |
| Watching from the terminal | `cli/watch.ts` | `show` (a transcript as text or JSON) and `tail` (deliveries and API calls as they happen) | — |
| The UI page in the binary | `ui/page.ts` (the page itself is `ui/index.html`) | Importing the page as text, for the binary's entry only | Import it from `app.ts`: the app takes the page as an option, so it also runs under Node |
| The list of drivers | `drivers/index.ts` | `DRIVERS`, `secretSpecs()` | Import a driver from core |

## Server: core (`server/src/core/`)

| Concern | Module | Use it for | Don't |
|---|---|---|---|
| Sessions and ownership | `sessions/` | Opening and closing scopes, `onClose` cleanup; sessions shared by name (`dev`, for the CLI, the UI and MCP) | Track ownership inside a driver |
| Object registry and handles | `registry/` | Typed collections per driver and type; resolving handle ids for a session (`get`), from the platform's side (`find`), and their owner | Keep a private `Map` of objects in a route |
| Ids in each platform's format | `ids/` | Every generated id (`U…`, `C…`, `ts`, GitHub numbers and node ids, UUIDs), seeded by `CHANNELSTACK_SEED`; validating fixed ids (`reserve`); reading the time out of a Slack `ts` (`slackTsTime`) | Call `crypto.randomUUID()` or format ids by hand |
| Secrets | `secrets/` | Fake tokens and signing secrets (the CSPRNG helpers, the token formats, `~/.channelstack/secrets.json`, 0600, rotation); live credentials in memory *(planned, phase 5)* | Generate or store a secret anywhere else |
| Signing and verification | `signing/`, one file per platform, `hmac.ts` shared | HMAC-SHA256 over the sent bytes, constant-time compare (`constantTimeEqual`); the echo signer; Slack v0 (`slack.ts`). `X-Hub-Signature-256`, `Linear-Signature` + `webhookTimestamp`, `X-Notion-Signature` *(planned, with each platform)* | Compute an HMAC or compare a secret in a driver |
| Access to the control API | `auth/` | Creating the bearer token, parsing `Authorization: Bearer`, the middleware (`requireAccess`); browser access for the UI (`ui.ts`): one-time login codes, the session cookie, and the short list of reads it allows | Compare tokens with `===`; let a cookie authorize anything but those reads |
| Event log and cursors | `events/` | Appending deliveries, API calls and actions (`EventLog`); cursor-based reads of any list (`CursorList`) | Keep per-driver logs or invent another cursor format |
| Delivery queue | `delivery/` | Sending events to the agent over HTTP with the platform's signer and ack window; keeping every delivery with its attempts; sending one again (`again`: a platform's retry headers, a forged signature); a platform's own retries (`RetryPolicy`, on the injected timers); cancelling a closed session's deliveries. Socket Mode *(planned, phase 2)* | Call `fetch` to the agent from a driver |
| Quiet detector | `quiet/` | "Is the agent idle, and for how long?" (`GET /sessions/{sid}/quiet`): busy while a provider call is in flight, a delivery is in flight or about to be retried, a driver reports open work (named, so a failure can say what was left open), or the agent was told to retry later (`expectMore` until it `arrived`); negative and exact-count matchers wait for it | Add sleeps or ad-hoc settle timers |
| Reality rules | `reality/` *(planned, phase 5)* | Fake or live per object, `unsupported_in_live`, `fake_actor_in_live_world` | Branch on `process.env` credentials in a driver |
| Safety and cleanup ledger | `safety/`, `ledger/` *(planned, phase 5)* | Live allowlists, tagging, cleanup, `channelstack sweep` | Delete live objects from a driver directly |
| Errors | `errors/` | The protocol's error codes and their HTTP status (`ProtocolError`), including a platform's own refusal surfaced through the control API (`{ platform, status }`) | Throw ad-hoc error shapes from routes |
| Redaction | `redact/` | Scrubbing tokens, secrets and emails from logs and errors (`text`), and tokens from recorded payloads (`tokens`) | Log request bodies or headers without it |
| Logging | `log/` | The one logger: JSON lines, redacted | Write to stdout or stderr from core or a driver |
| Routing helpers | `router/` | `registerRoute`, `DriverRouter`, zod-openapi registration, `x-channelstack-*` extensions; the `Driver`, `DriverContext` and `FakeBackend` contracts | Register Hono routes on the control API without the extensions |
| State directory | `home/` | `CHANNELSTACK_HOME`, writing 0600 files atomically, reading JSON state | Write a file with a secret any other way |
| Time | `clock/` | The injected clock, and injected timers (`Timers`, `delay`) for anything that happens later: a platform's retry, a pause, a fault's latency | Call `Date.now()` or `setTimeout` in core or a driver |
| portless | `portless/` | Registering and removing `*.localhost` names through the `portless` CLI | Spawn `portless` anywhere else |
| Proxy and CA | `proxy/`, `ca/` *(planned, phase 6)* | Host routing to fakes, the name-constrained CA | — |

## Server: drivers (`server/src/drivers/<channel>/`)

Each driver has the same files; see the contract in [architecture.md](architecture.md), section 3.3.

| File | Owns |
|---|---|
| `index.ts` | The driver's definition: its name, the secrets it needs, and how it is built from a `DriverContext` |
| `routes.ts` | Control API routes and schemas for this channel |
| `world.ts` | The `World` interface: each action written once; the channel's record types |
| `fake/` | `api.ts` (the fake provider API), `store.ts` (in-memory state), `world.ts` (the fake `World`: every change to the state happens here once, for people and for the app alike, and the caller brings the permission check; also what only a fake can do: forged deliveries, faults), `index.ts` (the `FakeBackend`) |
| `mentions.ts` (Slack) | `@name` in a test's text → the platform's mention syntax, and back (`nameMentions`, `splitAtMentions`); an emoji's name (`emojiName`) |
| `live/` | Real API calls as the app or a person, reads, cleanup handlers *(phase 5)* |
| `payloads.ts` | Builders for every event payload this platform sends (used by the fake's delivery) |
| `interaction-payloads.ts` (Slack) | Builders for what Slack sends when a person acts in the client: `block_actions`, `message_action`, slash command fields; a person's handle (`handleOf`) |
| `blocks.ts` (Slack) | Reading Block Kit: the text and controls a person sees, finding a button or a menu by label or `action_id`, filling in missing `block_id`s and `action_id`s |
| `fake/interactions.ts` (Slack) | What a person does beyond writing: clicks, menu choices, shortcuts, slash commands, and the app's answers through `response_url`. Part of the fake world |
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
| Waiting and polling | `wait` | The one polling loop: cursor reads, timeouts, quiet checks (`untilQuiet`; `watching` makes it look for the whole window, and a timeout names what the agent left open). Every `waitFor…`, `latest…` and matcher uses it |
| Durations | `duration` | Parsing `"3s"`, `"750ms"` |

The TypeScript SDK's entry is `sdks/typescript/client.ts` (`channelstack/client`), and `sdks/typescript/bin/channelstack.mjs` runs the platform's server binary.

## Scenarios (`scenarios/`)

| Concern | Module | Notes |
|---|---|---|
| Protocol parity scenarios | `smoke/*.yaml` | The format is [decisions/0002-smoke-scenario-format.md](decisions/0002-smoke-scenario-format.md) |
| Running a scenario through an SDK | `runners/typescript/run.ts`, `runners/python/run.py` | One interpreter per language, on the SDK's public API and its `wait` module |
| Reference agents | `agents/` | Plain programs with no channelstack code in them, configured from `channelstack env` |

## Examples (`examples/agents/`)

Reference agents for the acceptance suite: real frameworks, written as a developer would, with no channelstack code in them (`pnpm check:deps` enforces it).

| Concern | Module | Notes |
|---|---|---|
| What the agents answer | `shared/scripted-model.ts` | The scripted "model": short answers, and the AI SDK's mock model for streamed long-form. Every agent answers from here, so they behave the same |
| The Bolt app the Bolt agents start from | `shared/bolt.ts` | Configuration from the environment, `listen` |
| Bolt + AI SDK | `bolt-ai-sdk/agent.ts` | Mentions, DMs, reactions, native streaming |
| Chat SDK | `chat-sdk-slack/agent.ts` | The same behaviour on Vercel's Chat SDK and its Slack adapter |
| A deliberately broken agent | `mdac-220/agent.ts` | Leaves a lone "Thinking…" stream behind; exit check 1.4 proves the suite catches it |

## Scripts (`scripts/`)

| Concern | Module | Notes |
|---|---|---|
| The gate | `verify-phase.ts` | Standing checks, then the exit checks of phase 0..n |
| Building the spec from the routes; comparing generated files | `lib/generate.ts` | Used by `spec.ts` and `sdk.ts` (write, or `--check`) |
| Build targets and where build output goes | `lib/packages.ts` | The five targets, `binaryPath`, the platform package directories. Package and binary names come from the SDK launcher |
| Running processes | `lib/process.ts` | `run`, `capture`, `background`, `freePort`. Waiting is `waitFor` from the SDK runtime's `wait` module, here too |
| A Slack workspace for a unit test | `server/test/slack-workspace.ts` | `slackWorkspace` (the app, a stand-in agent, a session with Ana and a channel), `refusal`, `signedBy`. New Slack test files start from it |
| The app in memory, for unit tests | `server/test/app-harness.ts` | `harness` (the app called through `fetch`, no listener, with timers the test advances itself) and `recordingAgent` (a stand-in agent endpoint). Every driver's unit tests use it |
| Starting a server executable for a test or a smoke run | `lib/server.ts` | `startBinary`: spawn, wait for the server file, collect output, stop. The SDK launchers have their own start, because they ship |
| The binary under test, with a control API client | `server/test/integration/harness.ts` | `BINARY`, `cli`, `startBinary` (adds `control` to `lib/server.ts`'s). Shared by the server's and the SDK's integration tests |
| Compiling the server | `build-binary.ts` | `bun build --compile`, one npm package per platform |
| Running the server from source | `dev-server.sh` | Stands in for the binary (`CHANNELSTACK_SERVER_BIN`) on machines that block freshly compiled executables. CI never uses it |
| Smoke runs against the binary | `smoke.ts`, `accept.ts` | Server and reference agent next to each SDK's runner; `--repeat` for the flake check |
| A server next to a reference agent | `lib/stack.ts` | `withStack`: a private state directory, the binary, the agent with what `channelstack env` prints. Everything that needs both uses it |
| `api/examples` against the reference agents | `examples.ts` | `runExamples`, and `ENABLED_TESTS`: the example tests this phase has built. Also runs `test/acceptance/stack` |
| The examples against the generated SDK | `api-check.ts` | `pnpm api:check`: type errors in enabled tests fail; errors in tests of later phases are counted |
| Acceptance tests that aren't examples | `test/acceptance/` | `stack/` runs with the examples' server and agent (quiet, parallel sessions); the files next to it bring their own agent (`mdac-220`, the CLI and UI with a browser) |
| Packaging check | `pack-test.ts` | `npm pack` into an empty project |
| Stale-check self-test | `selftest-stale.ts` | Proves `spec:check` and `sdk:check` fail on drift |

## Test integrations (`integrations/`)

| Concern | Module | Notes |
|---|---|---|
| Matcher logic | `integrations/matchers-core/` | Framework-neutral matcher implementations built on the SDK's read methods and `wait`. Vitest and Jest adapt it; they don't reimplement matchers |
| Vitest | `integrations/vitest/` | Plugin (`index.ts`), attaching to or starting a server (`global-setup.ts`), a session and fixtures per test and the `expect.extend` adapter (`setup.ts`) |
| Jest | `integrations/jest/` *(planned, phase 7)* | Globals, the `expect.extend` adapter |
| Checks | `integrations/checks/` *(planned, phase 2)* | `slackChecks()` and friends, built on the public API only |
| pytest | `integrations/pytest-channelstack/` *(planned, phase 7)* | Fixtures and assertion helpers |

## Generated code (never edit by hand)

| Path | Generated from |
|---|---|
| `spec/openapi.json`, `spec/ir.json` | The routes (`pnpm spec`) |
| `sdks/typescript/generated/`, `sdks/python/channelstack/generated/` | `spec/ir.json` (`pnpm sdk`) |
