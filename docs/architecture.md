# channelstack architecture

> Concise overview, 2026-11-20. Detail lives in [implementation-plan.md](implementation-plan.md) (sections 3, 4, 8 and 11), [live-mode.md](live-mode.md) and the public types in [`api/`](../api).

## 1. The big picture

One server process fakes Slack, GitHub, Linear and Notion in memory. Tests, the CLI, MCP and the UI drive it through one control API. The agent under test talks to the fakes as if they were the real platforms.

```
 Vitest / Jest / pytest / Rust tests      channelstack CLI      MCP (coding agents)      UI (browser)
              │ generated SDK                  │                 │                     │
              └────────────────────────────────┴───── control API ┴─────────────────────┘
                                                        │  https://channelstack.localhost/_channelstack
                                                        ▼
┌──────────────────────────────────── channelstack server (Bun, single binary) ────────────────────────────────────┐
│  control API      Hono + zod-openapi routes, bearer token, loopback only                                     │
│  core             sessions · object registry · event log · delivery queue · reality rules ·                  │
│                   secrets · safety allowlist · cleanup ledger · recorder · proxy + CA                        │
│  drivers          slack │ github │ linear │ notion        (each: fake backend · live backend · inbound ·     │
│                                                            transcript · capabilities)                        │
└───────────────┬───────────────────────────────────────────────────────────────┬──────────────────────────────┘
       fake      │ provider APIs at https://slack.localhost, github.localhost, … │ live: real provider APIs
                 ▼                                                                ▼   (acting as the app or a person)
          agent under test  ◄── signed webhooks / Socket Mode (fake only)    Slack · GitHub · Linear · Notion
                                                                                 └── deliver to the agent directly
```

- **The agent is a separate process.** channelstack never starts or wraps it. `channelstack env` prints the tokens, signing secrets and base URLs it needs, and portless gives it a stable name (`https://my-agent.localhost`).
- **Fake is the default.** Live mode only acts on real platforms and reads the results back; it never relays events to the agent ([live-mode.md](live-mode.md)).

## 2. Three kinds of traffic

| Flow | Fake mode | Live mode |
|---|---|---|
| **Test → server** (control API) | `POST /_channelstack/sessions/{sid}/slack/users/{ana}/say` | Same route |
| **Agent → platform** (provider API) | The agent calls `https://slack.localhost/api/chat.postMessage` (base URL) or `slack.com` through the proxy. The fake serves it | The agent calls the real platform. channelstack sees it only if the agent runs in proxy mode |
| **Platform → agent** (events) | The server signs and delivers `event_callback`, webhooks and `AgentSessionEvent` over HTTP or Socket Mode | The real platform delivers. Not channelstack's concern |

## 3. Inside the server

### 3.1 Sessions are scopes in one shared world

The agent is configured once (one token and one base URL per channel), so there's **one** fake workspace, org and integration per server. A **session** is a scope inside it:

- **Ownership.** A session owns what it creates (users, channels, repos, pages). Generated names (`test-<id>`) never collide, so parallel tests don't see each other.
- **Scoped reads.** Each session's event log only holds deliveries and API calls caused by its own resources. The agent's `chat.postMessage` into a channel the session owns is attributed to that session.
- **Lifetime.** `DELETE /sessions/{sid}` removes everything the session created, in the fake and, through the cleanup ledger, live. Test fixtures open one session per test; the CLI, UI and MCP share a long-lived `dev` session.
- **Memory only.** A restart starts a fresh world.

### 3.2 Objects are handles, with the platform's own ids

Every object the test creates is a handle, and its id is **the id the real platform would use**. Fake mode should look real to the agent, to its logs and to whoever reads a failing test. Later calls take the id as a path parameter, which is what lets every SDK expose objects with methods:

```
POST /sessions/{sid}/slack/users                                    { name: "Ana" }
     → { id: "U08B5K2M9QX", name: "Ana" }
POST /sessions/{sid}/slack/channels                                 { participants: ["U08B5K2M9QX", "A08D4E5F6G7"] }
     → { id: "C08E1F2G3H4", name: "test-k3f9" }
POST /sessions/{sid}/slack/users/U08B5K2M9QX/say                    { text: "@my-agent hi", channel: "C08E1F2G3H4" }
     → { channel: "C08E1F2G3H4", ts: "1732101234.567899" }
GET  /sessions/{sid}/slack/conversations/C08E1F2G3H4/threads/1732101234.567899/replies?since=<cursor>
     → { replies, cursor }
```

Objects the platform identifies by more than one value get nested paths: a Slack message is channel + `ts`, a GitHub issue is `repos/acme/web/issues/12`.

| Platform | Object | Fake id (same shape as the real one) |
|---|---|---|
| Slack | Workspace, user, bot, app | `T08A1B2C3D4`, `U08B5K2M9QX`, `B08C7D1E2F3`, `A08D4E5F6G7` |
| | Channel, DM | `C08E1F2G3H4`, `D08F2G3H4J5`. Group DMs use whatever prefix real Slack returns (checked in the differential run) |
| | Message, thread | `ts` like `1732101234.567899`: epoch seconds, monotonic per channel. A thread is its root message's `ts` |
| | Event, view, file, trigger | `Ev08G3H4J5K6`, `V08H4J5K6L7`, `F08J5K6L7M8`, `trigger_id` in Slack's dotted numeric form |
| | Tokens | `xoxb-…`, `xoxp-…`, `xapp-…` with Slack's segment layout, random per install |
| GitHub | User, repo, App, installation | Numeric ids, logins as given (`ana`), bot `my-agent[bot]`, GraphQL node ids like `U_kgDO…`, `R_kgDO…` |
| | Issue, PR | Numbers sequential per repo and shared by issues and PRs (`#12`), plus numeric global ids and `I_kwDO…` / `PR_kwDO…` node ids |
| | Comment, review, check run | Numeric ids in GitHub's current ranges |
| | Commit | Real 40-hex SHAs from the fake's in-memory git store |
| | Delivery, tokens | `X-GitHub-Delivery` UUIDs; `ghs_…` installation tokens |
| Linear | Every object | UUIDs (v4). Issues also get identifiers like `ENG-123`, counted per team |
| | Tokens | `lin_oauth_…`, `lin_api_…` |
| Notion | Every object | UUIDs (v4), dashed in the API and as 32 hex characters in URLs |
| | Tokens | `ntn_…` |

- **Generated from a seeded random source** per world, so ids are unique and realistic. `CHANNELSTACK_SEED` makes a run reproducible.
- **Sequential where the platform is:** GitHub issue numbers, Linear identifiers, Slack `ts`.
- **Fixed ids on request:** `slack.createUser({ id: "U0ADMIN01" })` for agents that allowlist people. The id is checked against the platform's format.
- **URLs look real too,** on the fake hosts: `https://slack.localhost/archives/C08E1F2G3H4/p1732101234567899`, `https://github.localhost/acme/web/pull/12`, `https://linear.localhost/acme/issue/ENG-123/checkout-fails`, `https://notion.localhost/Roadmap-1f2e3d4c5b6a47988a7b6c5d4e3f2a1b`.
- **Only the session id is channelstack's own** (`ses_…`), since no platform has sessions.

Reads take a **cursor** ("what's new since my last read"). The event log is append-only, so polling is cheap and never misses anything.

### 3.3 Drivers own their platform

Each platform is one folder under `server/src/drivers/<name>/`. Core never changes for a new driver.

```ts
interface Driver {
  name: string;                        // "slack", "github", "linear", "notion", and the internal "echo" (decision 0003)
  routes(r: DriverRouter): void        // control API routes + Zod schemas → becomes the SDK surface
  fake: FakeBackend                    // provider API emulation (Hono app + in-memory store)
  live: LiveBackend                    // real API client, as the app or as a person, + cleanup handlers
  inbound: InboundAdapter              // fake: sign and deliver events to the agent
  transcript: TranscriptRenderer       // state → what a person would see (shared by fake and live)
  hosts: string[]                      // provider hosts the proxy routes to this fake
  capabilities(): CapabilityTable      // per action: fake / live / what live needs
}
```

The interface in the code (`server/src/core/router/driver.ts`) has only the members that exist so far; each phase adds the ones it first uses. Phase 0 locks `routes`, `fake` and `capabilities()` with the `echo` driver, and the `FakeBackend` design in [decisions/0001-fake-backend.md](decisions/0001-fake-backend.md).

**One action, two backends.** Each control action is written once against a `World` interface that both backends implement:

```
ana.say("@my-agent hi", { channel })
  └─► POST …/slack/users/U08B5K2M9QX/say
        └─► world.postAsUser(ana, channel, text)
              ├─ fake: write to the store → build event_callback → sign → deliver to the agent → log
              └─ live: chat.postMessage with Ana's token → record the created message in the ledger
```

That keeps the fake and the real platform from drifting apart in code. The nightly differential run compares them in behaviour (implementation plan 9).

**Transcripts.** Each driver renders its state into what a person would read: edits applied, deletes removed, streams joined, Block Kit as text with button labels, ephemeral messages only for their recipient. Text matchers and the UI both read this view.

### 3.4 Core services

| Service | Job |
|---|---|
| Event log | Append-only per session: deliveries (with every attempt), the agent's API calls, actions. Feeds cursors, matchers, the UI inspector and `channelstack tail` |
| Delivery queue | Signs and sends events to the agent the way each platform does: retries, timeouts, ack windows, Socket Mode. Faults and forged deliveries come from here |
| Reality rules | Decides fake or live per object from credentials, and refuses mixes like a fake person in a live workspace |
| Secrets | Fake tokens and signing secrets, generated once per install (`~/.channelstack/secrets.json`, mode 0600). Live credentials live only in memory and are never returned |
| Safety and ledger | Live allowlists; every live object is tagged and recorded so the session or `channelstack sweep` deletes it |
| Proxy + CA | For agents with hard-coded hosts: routes `slack.com`, `api.github.com`, … to the fakes, with a name-constrained CA trusted only by the agent |
| Quiet detector | Knows when the agent is idle (no open stream, no call in flight, a short settle window). Negative and exact-count matchers wait for it |
| State directory | `~/.channelstack`, or `CHANNELSTACK_HOME`: `secrets.json` and the running server's `server.json` (URL and bearer token), both 0600. A private server started by an SDK writes its token file elsewhere ([decisions/0004-state-directory.md](decisions/0004-state-directory.md)) |

## 4. Where the API logic lives

| Piece | Where | Hand-written or generated |
|---|---|---|
| Control API routes and schemas | `server/src/drivers/*/routes.ts` | Hand-written; **source of truth** for the SDKs |
| Public TypeScript API (the design contract) | `api/*.d.ts` | Hand-designed; the generated TS SDK must satisfy it |
| SDK resource classes and methods | `sdks/<lang>/generated/` | **Generated** |
| SDK transport, launcher, credential lookup | `sdks/<lang>/runtime/` | Hand-written, small |
| Fixtures and matchers | `integrations/` (`channelstack/vitest`, `channelstack/jest`, `pytest-channelstack`) | Hand-written on top of the generated read methods |

**Matchers run in the test process, not the server.** Each matcher polls a plain read method until the condition holds or the timeout passes, for example `toHaveReaction` → `message.reactions()`. Negative and exact-count matchers first wait for the server's quiet signal. That keeps the server free of assertion logic and lets each language use its own `expect`.

## 5. Generating the SDKs

### 5.1 Pipeline

```
server routes (Hono + zod-openapi)
        │  build step
        ▼
spec/openapi.json      OpenAPI 3.1 + x-channelstack-* extensions            (committed)
        │
        ▼
spec/ir.json           language-neutral: resources, methods, args,     (committed)
                       options, return types, enums, error codes
        │
        ├──► codegen/ts      ──► sdks/typescript/generated   ──┐
        ├──► codegen/python  ──► sdks/python/generated       ──┼─ + hand-written runtime per language
        └──► codegen/rust    ──► sdks/rust/generated         ──┘
```

We use our own small generator rather than Stainless, Fern or openapi-generator. Those produce flat clients (`client.slack.users.say(sessionId, userId, body)`); channelstack needs handle objects (`ana.say(text, { channel })`). The surface is tens of routes, so a generator in the repo is cheaper than bending a vendor's output.

### 5.2 How a route becomes a method

Each route is annotated with OpenAPI extensions that describe the object model:

```ts
// server/src/drivers/slack/routes.ts
r.post("/users/{user}/say", {
  body: SayBody,                       // { text, blocks?, channel?, to? }
  response: SayResult,                 // { message: MessageRef, thread: ThreadRef }
  "x-channelstack-method": { on: "SlackUser", name: "say", args: ["text"], options: ["channel", "to"] },
  "x-channelstack-error-codes": ["not_in_channel", "fake_actor_in_live_world"],
});
```

| Extension | Meaning |
|---|---|
| `x-channelstack-resource` | The route returns a handle of this type (`SlackUser`, `SlackThread`, …) |
| `x-channelstack-factory` | A method that creates a handle, on a fixture (`SlackFixture.createUser`) |
| `x-channelstack-method` | Binds the operation to a method on a handle. Path parameters bind to the handle's id; `args` become positional parameters, `options` the trailing options object |
| `x-channelstack-error-codes` | Errors the operation can return, mapped to typed exceptions |

The IR entry for that route:

```json
{ "resource": "SlackUser", "method": "say",
  "http": { "verb": "POST", "path": "/sessions/{session}/slack/users/{self}/say" },
  "args": [{ "name": "text", "type": "SlackMessageInput" }],
  "options": [{ "name": "channel", "type": "SlackConversation", "ref": true }, { "name": "to", "type": "SlackParticipant[]", "ref": true }],
  "returns": "SlackMessage", "errors": ["not_in_channel", "fake_actor_in_live_world"] }
```

Each emitter turns it into that language's idiom:

```ts
// TypeScript
const msg = await ana.say("@my-agent hi", { channel });
```

```python
# Python (async-first, sync facade, snake_case)
msg = await ana.say("@my-agent hi", channel=channel)
```

```rust
// Rust (builder for options)
let msg = ana.say("@my-agent hi").channel(&channel).send().await?;
```

Handles passed as options (`channel`) are sent by id (`"ref": true`); responses come back as ids and are wrapped into handles again.

### 5.3 The thin runtime per language

| Part | Job |
|---|---|
| Transport | HTTP client with the bearer token from `~/.channelstack/server.json`, retries while the server starts, error code → typed exception |
| Launcher | `auto` / `attach` / `start`: attaches to a running server at `https://channelstack.localhost` (or `CHANNELSTACK_URL`), otherwise starts the bundled binary and stops it on exit |
| Waiting and polling | The one polling loop behind every `waitFor…`, `latest…` and matcher: cursor reads, timeouts, quiet checks |
| Durations | Parsing `"3s"`, `"750ms"` |
| Credentials | Reads `CHANNELSTACK_<CHANNEL>_*` env vars for live mode and sends them once; the server never returns them (phase 5) |
| Disposal | Created resources clean up at the end of the session: `AsyncDisposable` in TS, context managers in Python, `close().await` in Rust. Generated from routes marked `dispose` |

The modules have the same names in every language ([code-map.md](code-map.md)).

### 5.4 Keeping the SDKs honest

- **One protocol, proven in every language.** About ten smoke scenarios in a small YAML step format (`scenarios/smoke/`, defined in [decisions/0002-smoke-scenario-format.md](decisions/0002-smoke-scenario-format.md)) run through every SDK in CI, like WebDriver's WPT.
- **No stale output.** CI fails if `openapi.json`, `ir.json` or any generated SDK is out of date with the routes.
- **The TS contract holds.** CI type-checks `api/examples/*.test.ts` against the generated TypeScript SDK, so the hand-designed API in `api/*.d.ts` and the generated one can't drift.
- **Versioning.** One tag releases the server, the spec and every SDK at the same version. SDKs check the server's major version on connect.

## 6. Distribution

| Target | How |
|---|---|
| Server | `bun build --compile` per platform (darwin-arm64/x64, linux-x64/arm64, windows-x64) |
| npm | `channelstack` (CLI, UI, `channelstack/vitest`, `channelstack/jest`, `channelstack/checks`) with `@channelstack/server-<platform>` as optional dependencies |
| PyPI | Per-platform wheels with the binary bundled; `pytest-channelstack` for fixtures and matchers |
| Rust | Downloads the release binary on first use, with checksum verification, or uses `CHANNELSTACK_SERVER_BIN` |
| Docker | `ghcr.io/<org>/channelstack` for CI and for proxy mode with Go or Linux agents |

## 7. Repository layout

```
channelstack/
  server/            Bun + Hono: src/app.ts, src/serve.ts, src/cli.ts, src/core/, src/drivers/{echo,slack,github,linear,notion}/
  ui/                functional browser UI (transcripts, inspector, chaos controls)
  api/               hand-designed public types (*.d.ts) + examples: the TS contract
  spec/              openapi.json, ir.json (generated, committed)
  codegen/           src/ir.ts (OpenAPI → IR) + src/emit/{typescript,python,rust}.ts
  sdks/typescript/   the npm package `channelstack`: runtime/ (hand-written), generated/, bin/ (runs the platform binary)
  sdks/python/       channelstack/runtime/ (hand-written) + channelstack/generated/
  sdks/rust/         runtime/ + generated/
  integrations/      vitest, jest, pytest-channelstack, checks
  scenarios/         smoke/*.yaml (protocol parity), runners/<language>/, agents/ (reference agents for the scenarios) + per-driver differential suites
  scripts/           the gate (verify-phase), spec and SDK generation, the binary build, packaging and smoke runs
  conformance/       schema validators, shape differ, coverage page
  docs/
```

The server binary and its per-platform npm packages (`@channelstack/server-<platform>`) are build output in `dist/npm/`, not sources.
