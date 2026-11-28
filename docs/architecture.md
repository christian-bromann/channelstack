# channelstack architecture

> Concise overview, 2026-11-20. Detail lives in [implementation-plan.md](implementation-plan.md) (sections 3, 4, 8 and 11), [live-mode.md](live-mode.md) and the generated API reference on the website.

## 1. The big picture

One server process fakes Slack, GitHub, Linear, Notion, Resend, Google (Gmail) and Discord in memory, and OpenAI's API for the agent's model (section 3.4). Tests, the CLI, MCP and the UI drive it through one control API. The agent under test talks to the fakes as if they were the real platforms.

```
 Vitest / pytest / Rust tests        channelstack CLI      MCP (coding agents)      UI (browser)
              │ generated SDK                  │                 │                     │
              └────────────────────────────────┴───── control API ┴─────────────────────┘
                                                        │  https://channelstack.localhost/_channelstack
                                                        ▼
┌──────────────────────────────────── channelstack server (Bun, single binary) ────────────────────────────────────┐
│  control API      Hono + zod-openapi routes, bearer token, loopback only                                     │
│  core             sessions · object registry · event log · delivery queue · reality rules ·                  │
│                   secrets · safety allowlist · cleanup ledger · recorder · proxy + CA                        │
│  drivers          slack │ github │ linear │ notion │ …    (each: fake backend · live backend · inbound ·     │
│                                                            transcript · capabilities)                        │
│  providers        openai                                   (the agent's model: fake only, scripted per test) │
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

Each agent process is configured once (its tokens and base URL per channel), so there's **one** fake workspace, org and integration per channel per server, and it holds the channel's apps: the built-in `my-agent`, and any app a test makes with `createApp({ name })` ([decision 0027](decisions/0027-multiple-apps.md)). Apps belong to the world, not to a session, so an agent's credentials outlive each test. A **session** is a scope inside it:

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

Objects the platform identifies by more than one value get nested paths: a Slack message is channel + `ts`, a GitHub issue is a repository and a number, `repos/1034567890/issues/12` (the repository by its id: decision 0013).

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
| Resend | Email, domain, webhook | UUIDs (v4). A webhook message is Svix's `msg_` and 27 base-62 characters (`svix-id`); a `Message-ID` is Amazon SES's, as Resend sends through it: `<0100019a` and 8 hex characters, `-`, a UUID, `-000000@email.amazonses.com>` |
| | People | A person is their mailbox: their id is their address |
| | Tokens | `re_<8>_<24>` API keys, `whsec_…` webhook secrets (base64 of 24 bytes) |
| Google | Message, thread | 16 hex characters, as Gmail gives them now: `19` and 14 more |
| | History | Decimal strings that grow with gaps; Pub/Sub message ids are 16 digits; user labels are `Label_<n>` |
| | Mail | A `Message-ID` Gmail gives: `<CA` and 40 base-62 characters `@mail.gmail.com>`. A person is their mailbox: their id is their address |
| | Tokens | Access tokens `ya29.…`, refresh tokens `1//0…`, client secrets `GOCSPX-…`, client ids `<12 digits>-<32>.apps.googleusercontent.com`; push tokens are RS256 JWTs signed with a per-install RSA key |
| Discord | Everything | Snowflakes: Discord's epoch in the high bits, so what is made now has now in it (`discordSnowflake`), and people, the guild and roles that existed before a test have a time between 2016 and 2025. A Gateway session is 32 hex characters |
| | Tokens | A bot token is `<the bot's id in base 64>.<6>.<38>`, so the bot's id is in it, as in Discord; an interaction's token `aW50ZXJhY3Rpb246…`; interactions are signed with a per-install Ed25519 key, whose public half is the app's |
| OpenAI (the fake model) | Chat Completion | `chatcmpl-` and 29 base-62 characters; `system_fingerprint` is `fp_` and 10 hex characters |
| | Response, conversation, items | A prefix and 48 hex characters: `resp_…`, `conv_…`, and the items `msg_…`, `fc_…` (function call), `ctc_…` (custom tool call), `rs_…` (reasoning) |
| | Tool call | `call_` and 24 base-62 characters |
| | Request, organization, project | `x-request-id` `req_` and 32 hex characters; `org-` and `proj_`, each with 24 base-62 characters |
| | Key | A project key: `sk-proj-`, 74 base-62 characters, `T3BlbkFJ`, 74 more, random per install |
| | The fake's own | A script `ms_` and 12 characters, a call held for a responder `mreq_` and 16 (lower-case base 36): OpenAI has neither |

- **Generated from a seeded random source** per world, so ids are unique and realistic. `CHANNELSTACK_SEED` makes a run reproducible.
- **Each app has its own:** an app a test makes gets every id the table lists for an app (Slack's app, bot and bot user; GitHub's App id, installation and `<name>[bot]`; Linear's and Notion's bot user; Resend's team and Google's mailbox), drawn from the seed and the app's name (`IdGenerator.named`), so they don't depend on the order tests make apps in.
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
              └─ live: chat.postMessage with Ana's token → the ledger lists its channel or DM for cleanup
```

That keeps the fake and the real platform from drifting apart in code. The nightly differential run compares them in behaviour (implementation plan 9).

**Transcripts.** Each driver renders its state into what a person would read: edits applied, deletes removed, streams joined, Block Kit as text with button labels, ephemeral messages only for their recipient. Text matchers and the UI both read this view.

### 3.4 Providers: the agent's model

A **provider** is a fake the agent calls that isn't a channel: it has no people, apps, deliveries or transcripts. The one provider is the fake OpenAI ([decision 0029](decisions/0029-fake-openai.md), phase 13), in `server/src/providers/openai/`, beside the drivers.

- **A driver definition with `provider: true`.** It registers like a driver (`DriverDefinition`: ids, token patterns, `secrets` for its API key, `hosts: ["api.openai.com"]` for proxy mode) and is listed in `DRIVERS`, but `CHANNELS`, and so the dev adapters, the channel unions and the UI's places, leave it out. Its `Driver` has a fake backend, `routes`, `env()` (`OPENAI_BASE_URL`, `OPENAI_API_KEY`), `openWork` and `problems`, and no live backend: it is fake in every run.
- **Served like the fakes.** Its API is at `https://openai.localhost/v1` (`/openai/v1` without portless, `api.openai.com` through the proxy), and its control routes are under the session like a channel's (`/sessions/{s}/openai/scripts`, `…/calls`, `…/rate-limits`). The spec says `provider: true` in `x-channelstack-channels`, the IR carries it on the channel (`IrChannel.provider`), and the emitters give it a fixture (`openai` in Vitest and pytest, `session.openai()` in Rust) with no people or places.
- **The same core.** The event log records its calls, the quiet detector counts a call in flight, the secrets store holds its key, and the redactor knows the `sk-proj-` shape. Streams go out through `core/stream` (server-sent events with first-token and between-chunk timing, a break by error, drop or stall, and a hold at `pauseAfter`).
- **Attribution.** A model call carries no session, so `core/attribution` gives it to one from the evidence in the request, strongest first: an id the fake minted for an earlier answer, a tag the agent sent (`user`, metadata, the `x-channelstack-session` header), an id or name only one session's deliveries and API answers hold, or text its people wrote. `core/attribution/place.ts` reads from the deciding delivery where in the channels the call belongs (`request.context`, `when: { from, in }`). A call it can't attribute is kept apart (`openai.unattributed()`) and refused.
- **Scripts belong to the session,** like faults, and go with it. A call no script answers gets a 400 `channelstack_no_script`; the driver's `problems(session)` reports it, so a waiting matcher fails at once and the session's close fails.
- **Responders run in the test process.** For `openai.respond(fn)` the server holds the agent's request, and the SDK long-polls `GET …/openai/scripts/{s}/requests` for held calls, runs the function and posts the turn to `POST …/openai/scripts/{s}/answers` (or the error its function threw). The routes are ordinary routes; the runtime's responder module drives them in each language.

### 3.5 Core services

| Service | Job |
|---|---|
| Event log | Append-only per session: deliveries (with every attempt), the agent's API calls, actions. Feeds cursors, matchers, the UI inspector and `channelstack tail` |
| Delivery queue | Signs and sends events to the agent the way each platform does: retries, timeouts, ack windows, Socket Mode. Faults and forged deliveries come from here |
| Reality rules | Decides fake or live per object from credentials, and refuses mixes like a fake person in a live workspace |
| Secrets | Fake tokens and signing secrets, generated once per install (`~/.channelstack/secrets.json`, mode 0600), a set per app (`apps.<driver>.<name>`). Live credentials live only in memory and are never returned |
| Loop guard | Fake only: counts the app writes in each conversation since a person last wrote there, and after 50 stops delivering the events those writes cause, records `bot_loop` and fails the test. A conversation is a Slack thread (top-level messages share the channel's), a Discord channel or thread, a GitHub issue or pull request, a Linear issue, a Notion page, an email thread or an echo room; the writes are messages and comments, and on Slack and Discord edits and reactions, on GitHub reviews, review comments and every `issues` and `pull_request` event, on Notion page edits, renames, blocks and child pages, on Gmail the sender's own SENT push. The table per channel is in [decision 0027](decisions/0027-multiple-apps.md), "The guard" |
| Safety and ledger | Live allowlists; every live object is tagged and recorded so the session or `channelstack sweep` deletes it |
| Proxy + CA | For agents with hard-coded hosts (`start --proxy`): a loopback proxy routes each driver's `hosts` (`slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`) to a TLS listener that serves the fakes, with a certificate from channelstack's own CA (name-constrained to those hosts, trusted only by the agent); other hosts tunnel through. A live driver's calls are passed on to the platform. `--record` writes every exchange's and webhook's shape for the shape differ ([decisions/0016](decisions/0016-proxy-mode-and-conformance.md)) |
| Quiet detector | Knows when the agent is idle (no open stream, no call in flight, a short settle window). Negative and exact-count matchers wait for it |
| State directory | `~/.channelstack`, or `CHANNELSTACK_HOME`: `secrets.json` and the running server's `server.json` (URL and bearer token), both 0600. A private server started by an SDK writes its token file elsewhere ([decisions/0004-state-directory.md](decisions/0004-state-directory.md)) |

## 4. Where the API logic lives

| Piece | Where | Hand-written or generated |
|---|---|---|
| Control API routes and schemas | `server/src/drivers/*/routes.ts` | Hand-written; **source of truth** for the SDKs |
| SDK resource classes and methods | `sdks/<lang>/generated/` | **Generated** |
| SDK transport, launcher, credential lookup | `sdks/<lang>/runtime/` | Hand-written, small |
| Fixtures and matchers | `integrations/` (`channelstack/vitest`, `pytest-channelstack`) | Hand-written on top of the generated read methods |

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

Each route is registered with a spec that carries its Zod schemas and how it shows up in the SDKs. The same spec produces the validation, the OpenAPI operation and its extensions:

```ts
// server/src/drivers/echo/routes.ts
router.route({
  method: "post",
  path: "/users/{user}/say",
  params: UserParams,
  body: z.object({ text: z.string().min(1), room: z.string().openapi({ "x-channelstack-ref": ["EchoRoom"] }) }),
  response: EchoMessage,
  errors: ["not_found", "not_in_room"],
  sdkMethod: { on: "EchoUser", name: "say", args: ["text"], options: ["room"] },
  stability: "experimental",
  handler: ({ session, params, body }) => world.postAsUser(session.id, params.user, body.room, body.text),
});
```

| Extension | On | Meaning |
|---|---|---|
| `x-channelstack-resource: { id?, scope? }` | A schema | Values of this schema are handles (`EchoUser`, `Session`, …). `id` names the field that identifies the handle; fixtures have none. `scope: "session"` marks the session itself: its id is the `{session}` of everything created through it |
| `x-channelstack-ref: [resources]` | A request field | The field takes a handle of one of these types and sends its id |
| `x-channelstack-factory` | An operation | A method that creates a handle (`EchoFixture.createUser`, `Channelstack.openSession`) |
| `x-channelstack-method` | An operation | A method on a handle. `args` become positional parameters and `options` the trailing options object. Path parameters bind to the handle: `{session}` to its session, the remaining one to its id, or to the field named in `bind`. `dispose: true` marks the method SDKs call when the handle is disposed |
| `x-channelstack-error-codes` | An operation | Error codes the operation can return, mapped to typed exceptions |
| `x-channelstack-stability` | An operation | `experimental` or `stable` (implementation plan 4.5) |
| `x-channelstack-live` | An operation | How it works on a live driver: `{ unsupported }` (refused with `unsupported_in_live`) or `{ requires: "browser" \| "proxy" }` (refused with `action_requires`), each with its reason. Left out, it works live ([decision 0015](decisions/0015-live-mode.md)) |
| `x-channelstack-credential` | A request field | An optional credential: left out, SDKs read it from the environment variable the template names, `{field}` filled in from that field (`CHANNELSTACK_SLACK_USER_{name}_TOKEN`) |

Every operation must have a factory or a method binding, and every body field and query parameter must be an argument or an option. The IR builder refuses a spec that no SDK could call.

The IR entry for that route (`spec/ir.json`), under the resource `EchoUser`:

```json
{ "name": "say", "kind": "method", "stability": "experimental",
  "http": { "verb": "POST", "path": "/sessions/{session}/echo/users/{user}/say",
            "pathParams": [{ "name": "session", "from": "session" }, { "name": "user", "from": "self", "field": "id" }] },
  "args": [{ "name": "text", "type": { "kind": "string" }, "optional": false, "in": "body" }],
  "options": [{ "name": "room", "type": { "kind": "ref", "resources": ["EchoRoom"] }, "optional": false, "in": "body" }],
  "returns": { "kind": "named", "name": "EchoMessage" },
  "errors": ["unauthorized", "invalid_argument", "internal", "session_not_found", "not_found", "not_in_room"],
  "dispose": false }
```

Each emitter turns it into that language's idiom. For the Slack route `POST …/slack/users/{user}/say`, bound the same way:

```ts
// TypeScript
const msg = await ana.say("@my-agent hi", { channel });
```

```python
# Python (async-first, snake_case, options as keyword arguments)
msg = await ana.say("@my-agent hi", channel=channel)
```

```rust
// Rust (builder for options)
let msg = ana.say("@my-agent hi").channel(&channel).send().await?;
```

Handles passed as arguments or options are sent by id (`kind: "ref"`). In responses, a field whose schema is a resource comes back as that handle's data (`kind: "resource"`) and is wrapped into a handle again.

### 5.3 The thin runtime per language

| Part | Job |
|---|---|
| Transport | HTTP client with the bearer token from `~/.channelstack/server.json`, retries while the server starts, error code → typed exception |
| Launcher | `auto` / `attach` / `start`: attaches to a running server at `https://channelstack.localhost` (or `CHANNELSTACK_URL`), otherwise starts the server binary and stops it on exit. TypeScript finds the binary at `CHANNELSTACK_SERVER_BIN` or in its `@channelstack/server-<platform>` optional dependency; Python and Rust at `CHANNELSTACK_SERVER_BIN` or `channelstack` on the `PATH` |
| Waiting and polling | The one polling loop behind every `waitFor…`, `latest…` and matcher: cursor reads, timeouts, quiet checks. It holds the one default timeout (10 s) and quiet window (750 ms) every wait method uses; the test integrations set it from their options (Vitest's `timeout` and `quietFor`, pytest's `channelstack_timeout` and `channelstack_quiet_for`), and read it when they aren't set. In Rust it is a constant (`DEFAULT_TIMEOUT`, `DEFAULT_QUIET_FOR`), since no test integration sets it |
| Durations | Parsing `"3s"`, `"750ms"` |
| Credentials | Reads `CHANNELSTACK_<CHANNEL>_*` env vars for live mode and sends them once; the server never returns them (phase 5) |
| Disposal | What a test created is cleaned up when its session closes. Outside fixtures, the client, the session and a Slack fault are disposable: `AsyncDisposable` in TS, context managers in Python, `close().await` in Rust. Generated from routes marked `dispose` |

The modules have the same names in every language ([code-map.md](code-map.md)).

In Rust (`sdks/rust`, crate `channelstack`), every handle is a struct with typed getters for its fields, and every method returns a builder: option setters, then `.send().await` or `.await` directly (`IntoFuture`). Waits are builders too (`thread.wait_for_reply().from("my-agent").timeout("5s").await`). Arguments that take a handle take any `&impl Handle`; errors are one `channelstack::Error` with the protocol's `code()`. What isn't a handle (a transcript, a page of messages, a status) comes back as `serde_json::Value`, so a transcript's text is `transcript["text"]`, and printing the value prints JSON, not the text that `str()` and `toString()` give in Python and TypeScript. The smoke runner (`scenarios/runners/rust`) calls methods by their API names through the generated `call_by_name`. The matchers are in the crate (`channelstack::expect`, hand-written in `src/expect/`), with matchers-core's semantics and messages: `expect(&thread).to_have_reply_from("my-agent").text(Regex::new("(?i)incident")?).await?`, `expect(&thread).not_to_have_reply_from(&app).await?`. Each returns a builder that awaits to `Result<()>`; a failed check is `Error::Expectation` with the whole message, so `?` fails a test that returns `channelstack::Result`. A matcher exists only on the handles it can read, and its defaults are the waits' constants.

### 5.4 Keeping the SDKs honest

- **One protocol, proven in every language.** About ten smoke scenarios in a small YAML step format (`scenarios/smoke/`, defined in [decisions/0002-smoke-scenario-format.md](decisions/0002-smoke-scenario-format.md)) run through every SDK in CI, like WebDriver's WPT.
- **No stale output.** CI fails if `openapi.json`, `ir.json` or any generated SDK is out of date with the routes.
- **The examples hold the TypeScript SDK to its use.** `pnpm typecheck` type-checks `test/acceptance/examples/*.test.ts` against the generated TypeScript SDK, and the acceptance run plays them against the reference agents.
- **Versioning.** One tag releases the server, the spec and every SDK at the same version ([releasing](release.md)). SDKs check the server's major version on connect.

## 6. Distribution

| Target | How |
|---|---|
| Server | `bun build --compile` per platform (darwin-arm64/x64, linux-x64/arm64, windows-x64) |
| npm | `channelstack` (CLI, UI, `channelstack/vitest`, `channelstack/checks`) with `@channelstack/server-<platform>` as optional dependencies |
| PyPI | `channelstack`, without the binary: the launcher finds it at `CHANNELSTACK_SERVER_BIN` or `channelstack` on the `PATH` (for example from the npm package); `pytest-channelstack` for fixtures and matchers |
| Rust | The crate `channelstack`, without the binary and without downloading one: it finds it at `CHANNELSTACK_SERVER_BIN` or `channelstack` on the `PATH` |
| Docker | `ghcr.io/<org>/channelstack` for CI and for proxy mode with Go or Linux agents. Not in the first release ([decision 0023](decisions/0023-releases.md)) |

## 7. Repository layout

```
channelstack/
  server/            Bun + Hono: src/app.ts, src/serve.ts, src/cli.ts, src/core/, src/drivers/{echo,slack,github,linear,notion,resend,google,discord}/, src/providers/openai/
  ui/                functional browser UI (transcripts, inspector, chaos controls)
  spec/              openapi.json, ir.json (generated, committed)
  codegen/           src/ir.ts (OpenAPI → IR) + src/emit/{typescript,python,rust}.ts
  sdks/typescript/   the npm package `channelstack`: runtime/ (hand-written), generated/, bin/ (runs the platform binary)
  sdks/python/       channelstack/runtime/ (hand-written) + channelstack/generated/
  sdks/rust/         the crate `channelstack`: src/runtime/ (hand-written) + src/generated/
  integrations/      vitest, pytest-channelstack, checks
  scenarios/         smoke/*.yaml (protocol parity), runners/<language>/, agents/ (reference agents for the scenarios) + per-driver differential suites
  test/acceptance/   the acceptance suite: examples/ (the API in use), stack/, checks/, pytest/
  scripts/           the gate (verify-phase), spec and SDK generation, the binary build, packaging and smoke runs
  conformance/       schema validators, shape differ, coverage page
  skills/channelstack/  the skill for coding agents that drive the MCP tools (skills.sh)
  docs/
```

The server binary and its per-platform npm packages (`@channelstack/server-<platform>`) are build output in `dist/npm/`, not sources.
