# channelstack: implementation plan

Status: draft, 2026-11-19. Builds on the research in `docs/research/` and `docs/competitive-analysis.html`.

The public test API follows `docs/devx.md` and the type definitions in `api/`. Highlights:
- Actions are methods on the person, with the content first and the place as an option: `ana.say("…", { channel })`.
- Users, channels, repos and pages are created per test.
- The agent's app is described once in `channelstack.config.ts`.
- Matchers come through each test framework's `expect`.

## 1. What we are building

channelstack lets you write an end-to-end test for an agent that lives in Slack, GitHub, Linear or Notion. A test plays the people around the agent: it posts the DM, opens the issue, clicks the button, presses Stop. It then reads back what those people would see. The same test runs against a fake platform on every PR and against the real platform nightly.

```ts
// channelstack.config.ts describes the agent's app (manifest, delivery URLs); fake by default, real with credentials
test("a DM gets one threaded answer", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" })          // fake person, or real with { token }
  const msg = await ana.say("@robin summarize #812", { to: slack.app })
  await expect(msg.thread).toHaveRepliesFrom("robin", { count: 1 })
})
```

The architecture copies WebDriver:

- **One server.** It's written in Bun and shipped as a single binary. It holds all platform logic: fakes, live adapters, signing, delivery and transcripts.
- **One protocol.** The server exposes a plain HTTP+JSON control API, described by an OpenAPI document that is generated from the server's own route definitions.
- **Many SDKs.** They're generated from that document. TypeScript comes first, then Python and Rust. An SDK contains no platform logic, so adding a language never means re-implementing Slack.

### Goals

1. **Multi-language from day one.** The TypeScript SDK ships first. The Python SDK is generated in CI from the first milestone, even while it's thin, so the protocol can't quietly become TypeScript-shaped.
2. **Fake and real behind one API.** Credentials decide what's real, per object (section 5).
3. **Everything is checked against the real platforms.** The fake is only trusted where the live run of the same test agrees with it (section 9).
4. **Slack, GitHub, Linear and Notion first.** The driver model has to take Stripe, Discord, Teams or email without changing the core.
5. **Framework-neutral.** It must work for MDA, Chat SDK, AI SDK, Pi, Bolt and Probot agents. The test treats the agent as a black box that receives platform events and calls platform APIs.

### Non-goals (for now)

- **Faking the LLM.** Agents bring their own deterministic model: the AI SDK mock models, emulate's AI service, or MDA's scripted directive fixtures. Section 10 shows the recipes.
- **Waits and assertions in the protocol.** The server only serves reads (transcripts, event logs). The waiting matchers (`toHaveRepliesFrom`, `toHaveCommentsFrom`, …) live client-side in the test-framework integrations (`channelstack/vitest`, `channelstack/jest`, `pytest-channelstack`), which poll those reads.
- **Hosting or a cloud product.**
- **A unified "message" abstraction across platforms.** Each driver defines its own nouns: a Slack thread, a GitHub timeline, a Linear agent session, a Notion page with comments.

### 1.1 Shared decisions with `devx.md`

This plan and `docs/devx.md` describe the same product. Where they used to differ, they now agree on the following:

| Topic | Decision |
|---|---|
| Addresses | portless names: `https://slack.localhost`, `github.localhost`, `linear.localhost`, `notion.localhost`; the UI and control API at `https://channelstack.localhost`. With `--no-portless`, one port with path prefixes (`http://localhost:4500/slack/...`) |
| The world | **One shared fake world per server:** one Slack workspace, one GitHub org, one Linear workspace, one Notion workspace. The agent is configured once (one token and one base URL per channel), so there can't be a separate world per test |
| Sessions | A session is a **scope inside that world**, not a world of its own. It owns the users, channels, repos and pages it created, filters the event log to deliveries its actions caused, and cleans everything up on `DELETE`. Each test-framework fixture opens one session per test, and the CLI and UI share a long-lived `dev` session |
| Starting the agent | channelstack never starts or wraps the agent. `channelstack exec` is dropped; you run `channelstack env` and then `portless run my-agent pnpm dev` |
| Config | `channelstack.config.ts` describes only the agent's app on each channel (fake by default, real with credentials). People and places are created per test |
| Test API | Actor-first and per-framework (`api/*.d.ts`): `ana.say(text, { channel })`, with fixtures and matchers in `channelstack/vitest`, `channelstack/jest` and `pytest-channelstack` |
| Secrets | Fake tokens and signing secrets are generated with a CSPRNG **once per install** and kept in `~/.channelstack/secrets.json` (mode 0600). They stay stable across restarts so `.env.local` stays valid. `channelstack secrets rotate` replaces them |
| State | In memory. A restart starts a fresh world |
| Scope | Slack, GitHub, Linear and Notion. No Teams for now |
| Base URL vs proxy | Base-URL mode through portless is the default. Proxy mode is for agents with hard-coded hosts, like MDA |
| Live mode | It stays (section 5), and devx.md now describes it too |

## 2. Lessons from the closed MDA stack

The closed stack, #1040 → #1122, added 17.9k lines. Only 16% of those lines were e2e test cases; the rest was infrastructure that belongs in a shared tool:

| Closed-stack category | Lines | Where it goes in channelstack |
|---|---|---|
| Fakes (Slack/GitHub/Linear) | 3,824 | Server drivers |
| Harness | 3,396 | Server core and the SDK |
| Fake and stack unit tests | 1,627 | channelstack's own test suite |
| Product URL overrides | 1,464 | Mostly removed by proxy mode (section 6.2) |
| Fixtures | 1,239 | Driver seeds and recorded cassettes |
| Patches to langchainplus | 162 | Removed by proxy mode |
| **e2e test cases** | **2,788** | **Stays in MDA. This is the only part MDA should own.** |

What went wrong with emulate 0.12.3, the version the stack used:

- **Slack:** no streams, no assistant status, no Stop.
- **Linear:** answered only `viewer`.
- **GitHub:** App endpoints missing, and timestamp delivery IDs.
- **Base URLs:** every swap forced product changes.

Emulate 0.14 has since closed some of these, but not streams, Stop, proxying or any fidelity evidence.

**Success criterion for phase 8:** MDA's e2e suite is the 2,788 lines of test cases plus less than 300 lines of setup.

## 3. Architecture

> A shorter overview of the server and the SDK generator is in [architecture.md](architecture.md).

```
            test (any language)
                 │  generated SDK
                 ▼
┌──────────────────────────────── channelstack server (Bun) ───────────────────────────────┐
│ control API  https://channelstack.localhost/_channelstack/sessions/{sid}/<driver>/...         │
│              (OpenAPI 3.1, bearer token, loopback only) · UI at channelstack.localhost   │
│                                                                                     │
│ core: sessions · object registry · reality rules · event log · delivery queue       │
│       secrets vault · safety allowlist · cleanup ledger · recorder · CA + proxy     │
│                                                                                     │
│ drivers:  slack │ github │ linear │ notion │ (stripe, discord, …)                   │
│   each = control routes + fake backend + live backend + inbound + transcript        │
└─────────────┬──────────────────────────────────────────┬────────────────────────────┘
              │ fake: https://<driver>.localhost         │ live: real provider APIs
              │       (portless) or via proxy mode       │
              ▼                                          ▼
       agent under test  ◄── signed webhooks / Socket Mode (fake)   or   real deliveries (live)
```

Three kinds of traffic go through the server:

1. **Test, CLI, MCP or UI → server (control API).** These are channelstack's own routes: `POST /_channelstack/sessions/{sid}/slack/users/{user}/say`.
2. **Agent → platform (provider API).** In fake mode, the agent's `chat.postMessage` reaches the fake, either by base URL or through the proxy. In live mode it goes to real Slack, and channelstack isn't involved unless recording is on.
3. **Platform → agent (inbound).** In fake mode, the server signs and delivers `event_callback`, webhooks and `AgentSessionEvent` to the agent's endpoint. In live mode, the real platform delivers them.

The agent is a separate process that channelstack never starts or wraps. `channelstack env` (or the `channelstack.env()` fixture method) gives it the environment it needs (section 6).

## 4. The protocol

### 4.1 Sessions

Sessions work like WebDriver's, with one difference: they're **scopes in one shared world, not separate worlds**. The agent is configured once, with one token and one base URL per channel, so every session talks to the same workspace, org and integration.

- **`POST /sessions`** opens a scope and returns `{ sessionId, drivers }`. Per-action capabilities are read per driver (`GET …/<driver>/capabilities`, section 4.3). Each test-framework fixture opens one per test. The CLI, UI and MCP share a long-lived session named `dev`.
- **Isolation comes from ownership.** A session owns what it created (users, channels, repos, teams, pages), and generated names (`test-<id>`) never collide. Tests running in parallel therefore don't see each other's conversations, even in one workspace.
- **Reads are scoped.** `GET …/events` returns only deliveries and API calls caused by the session's own resources. Attribution follows the conversation: the agent's `chat.postMessage` into a channel the session owns belongs to that session.
- **`DELETE /sessions/{sid}`** removes everything the session created, in the fake and, through the cleanup ledger, on live platforms.
- **`GET /status`** reports server health, the server version and which drivers are loaded.
- **`POST /reset`** drops the whole world. This is what `channelstack reset` runs; avoid it in parallel suites.

### 4.2 Objects are handles, with the platform's own ids

Each object the test creates is a handle whose id is **the real platform's id format**, so fake mode looks real to the agent, its logs and anyone reading a failure. Later calls take the id as a path parameter. This is what makes the object-style SDK API possible in any language.

```
GET  /sessions/{sid}/slack/app                                     → { id: "A08D4E5F6G7", botUserId: "U08K1L2M3N4", teamId: "T08A1B2C3D4", live: false }   (from channelstack.config.ts)
POST /sessions/{sid}/slack/users                      { name, id?, admin?, token? }                     → { id: "U08B5K2M9QX", live: false }
POST /sessions/{sid}/slack/channels                   { name?, private?, participants: ["U08B5K2M9QX", "A08D4E5F6G7"] } → { id: "C08E1F2G3H4", name: "test-k3f9" }
POST /sessions/{sid}/slack/users/{user}/say           { text, blocks?, channel | to }                   → { channel: "C08E1F2G3H4", ts: "1732101234.567899" }
POST /sessions/{sid}/slack/users/{user}/reply         { text, thread: { channel, ts } }                 → { channel, ts, threadTs }
POST /sessions/{sid}/slack/users/{user}/click         { button: label | { actionId }, message | thread } → { delivery: "Ev08G3H4J5K6" }
POST /sessions/{sid}/slack/users/{user}/stop          { thread: { channel, ts } }                       → { delivery }
GET  /sessions/{sid}/slack/conversations/{channel}/threads/{ts}/transcript?since=<cursor>              → { messages, cursor }
GET  /sessions/{sid}/github/repos/{repo}/issues/{number}/comments?since=<cursor>                       → { comments, cursor }
GET  /sessions/{sid}/linear/issues/{identifier}/sessions                                               → { sessions }
GET  /sessions/{sid}/events?since=<cursor>                                                             → { events, cursor }
GET  /sessions/{sid}/slack/capabilities                                                                → per-action { fake, live, liveRequires }
```

The routes mirror the SDK one to one: `ana.say(text, { channel })` is `POST …/users/{ana.id}/say { text, channel: channel.id }`. Actions sit under the acting user, and the place is a body field. Objects the platform identifies by more than one value get nested paths (a Slack message is channel + `ts`; a GitHub issue is owner, repo and number). Each test-framework fixture opens one session per test and closes it at the end (section 4.1). All routes are served under `https://channelstack.localhost/_channelstack`.

#### 4.2.1 Id formats

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

Ids are unique across the shared world, not just the session. Cursors are opaque, and they're how tests poll: "give me what's new since the last read". The server keeps an append-only event log per session, so polling is cheap and never misses anything.

### 4.3 Drivers own their nouns

There's no shared `message` type in the protocol. Each driver registers its routes under its own prefix, with its own Zod schemas, and the OpenAPI document is just the union of what the drivers register. Slack has `threads` and `click`; GitHub has `repos`, `issues`, `pulls`, `review` and `redeliver`; Notion has `pages`, `comments` and `mention`. There's no module or capability registry: one driver per platform, and the driver brings its own schema.

Every driver does share two conventions:

- `GET .../capabilities` lists the driver's actions with fake and live support. It drives the reality rules, the generated docs and the coverage page.
- `GET .../<container>/transcript` returns that driver's human-view model (section 7).

### 4.4 Errors

Errors follow the WebDriver style: a stable `error` code, a human-readable `message`, and `data`. Codes are part of the spec, so every SDK can turn them into typed exceptions.

| Code | When |
|---|---|
| `fake_actor_in_live_world` | A fake user acts in a live workspace (section 5) |
| `live_not_allowlisted` | The live workspace/org/team isn't in `CHANNELSTACK_LIVE_*` |
| `action_requires` | A live action needs something missing, for example `click` needs `{ browser }` for a real Slack user |
| `cross_workspace_credential` | The user's token belongs to a different workspace than the app |
| `unsupported_in_fake` / `unsupported_in_live` | The action isn't implemented for that reality yet |
| `not_found`, `invalid_argument`, `session_not_found`, `unauthorized` | The usual |

Messages never echo tokens or upstream response bodies. Those go to the internal debug log, with redaction.

### 4.5 Versioning

- The protocol version is the server's semver, and `GET /status` reports it.
- SDKs are generated per server release and check the server's major version on connect.
- Each driver's routes are marked `x-channelstack-stability: experimental | stable`. Breaking changes to stable routes need a major version.

## 5. Real versus fake: credentials decide

```ts
// channelstack.config.ts
slack: { app: { name: "robin", manifest: "./slack-manifest.yaml" } }                     // fake app (server generates signing secret + bot token)
slack: { app: { name: "robin", manifest: "./slack-manifest.yaml", appId, botToken } }    // real app

// in a test
await slack.createUser({ name: "Ana" })                                                  // fake person
await slack.createUser({ name: "Ana", token: process.env.ANA_SLACK_TOKEN })              // real person
```

The rule: **a conversation lives where its app or container lives, and everyone who acts in it has to be able to exist there.**

| Container | Actor | Result |
|---|---|---|
| fake | fake | Everything runs in the fake |
| fake | real | Allowed. The credential is used only for identity: name and avatar are copied into the fake |
| real | real | Live. The actor uses their own token |
| real | fake | Refused with `fake_actor_in_live_world` |

How credentials are resolved:

- **From the environment as well as code.** `slack.createUser({ name: "Ana" })` looks for `CHANNELSTACK_SLACK_USER_ANA_TOKEN` (from the user's name), and the Slack app from the config looks for `CHANNELSTACK_SLACK_APP_ID` and `CHANNELSTACK_SLACK_BOT_TOKEN`. One test file therefore runs fake on PRs and live nightly, with no edits.
- **Forcing a reality.** `CHANNELSTACK_REALITY=fake` forces fake everywhere, even when credentials are present. This protects local runs. `CHANNELSTACK_REALITY=live` fails if any object would fall back to fake.
- **Checked on creation.** Credentials are checked when the object is created: `auth.test` on Slack, `GET /user` on GitHub, `viewer` on Linear, `users/me` on Notion. The workspace, org or team must match the container's and must be allowlisted.
- **Kept on the server.** Credentials live in the session's in-memory vault. The SDK sends them once, the server never returns them, and recordings redact them.

Per platform:

| Platform | Real container | Real actor | Live gaps (no public API) |
|---|---|---|---|
| Slack | App in a sandbox workspace: `appId` and `botToken`. channelstack never changes the app's configuration live | User token (`xoxp`) per test user, installed once in the sandbox | Button clicks, Stop, modal submit. Browser actor (8.5) |
| GitHub | GitHub App (`appId` and private key) installed on a test org. Repos are created per session, named `channelstack-<run>-<n>` | Fine-grained PAT of a machine user | App install and permission-acceptance flows. Redelivery works through `POST /app/hook/deliveries/{id}/attempts` |
| Linear | OAuth app with the agent actor, in a test workspace and team | Personal API key per test user | Stopping or dismissing an agent session from the UI is unverified (spike). Redelivery is unclear |
| Notion | Integration (internal or public) connected by hand, once, to a test teamspace page. Child pages inherit access, and the API can't add connections | Personal access token (PAT) per test user, which acts as that person | Resolving discussions and adding connections are UI-only (browser actor). No webhook redelivery API, so redelivery is fake-only |

The full per-feature breakdown of what works live, and what it needs (user token, app credentials, browser or proxy), is in [reality-matrix.md](reality-matrix.md).

## 6. How the agent under test is wired up

channelstack never starts or wraps the agent. It produces the environment the agent needs, and the agent runs however it normally runs:

```bash
npx channelstack env >> .env.local            # tokens, signing secrets, API URLs, CA settings
portless run my-agent pnpm dev           # the agent at https://my-agent.localhost
```

```ts
const env = await channelstack.env()          // the same values from the `channelstack` fixture, e.g. to spawn the agent in globalSetup
```

The agent's inbound endpoint is part of the app in `channelstack.config.ts`: `slack: { app: { name, manifest, urls: { events: "https://my-agent.localhost/slack/events" } } }`. Because the agent runs under its own portless name, that URL never changes. A real Slack app can't use this, because Slack delivers wherever the Request URL points. See 6.3.

### 6.1 Base-URL mode (default)

Each driver's fake is served by portless at a stable name. Where the agent's SDK accepts a base URL, `channelstack env` sets it:

| Platform | Address | Setting |
|---|---|---|
| Slack | `https://slack.localhost/api/` | `slackApiUrl` / `SLACK_API_URL` |
| GitHub | `https://github.localhost` | Octokit `baseUrl` / `GITHUB_API_URL` |
| Linear | `https://linear.localhost/graphql` | `apiUrl` / `LINEAR_API_URL` |
| Notion | `https://notion.localhost` | `baseUrl` / `NOTION_BASE_URL` |

- **TLS comes from portless.** Its CA is in the system trust store. `channelstack env` adds what each runtime needs to read it: `NODE_USE_SYSTEM_CA=1`, a certifi-plus-portless bundle for Python, and `SSL_CERT_FILE` for Go on Linux.
- **Without portless** (`--no-portless`, mostly CI), all fakes share one port with path prefixes (`http://localhost:4500/slack/api/`), and no certificates are involved.
- **These names don't collide with emulate,** whose portless mode uses `*.emulate.localhost`.

### 6.2 Proxy mode (no product changes)

For agents that hard-code hosts, or that run on stacks you don't control, there's proxy mode. This is MDA's case: Trigger Server, Go services, langchainplus.

1. **Generate a CA.** This is channelstack's own CA, separate from portless's. The server creates one per install, stored in `~/.channelstack/ca/` with mode `0600`. It's name-constrained to the routed provider hosts and never added to the system trust store.
2. **Inject trust into the agent only.** `channelstack env --proxy` adds:

   | Variable | For |
   |---|---|
   | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | All proxy-aware clients |
   | `NODE_EXTRA_CA_CERTS`, plus `NODE_USE_ENV_PROXY=1` | Node 24 |
   | `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` | Python |
   | `SSL_CERT_FILE` | Go on Linux. **Go on macOS ignores it**, so the docs say "use Docker or Linux for Go agents in proxy mode" |

3. **Route by host.** `slack.com`, `api.github.com`, `api.linear.app` and `api.notion.com` go to the same fakes that `*.localhost` serves. Every other host passes through untouched. There's one world, so the proxy doesn't need to tell sessions apart.
4. **Record in live mode.** The same proxy, in pass-through, records agent↔platform traffic as cassettes. Section 9 uses those cassettes.

### 6.3 Inbound delivery

| Mode | How events reach the agent |
|---|---|
| Fake, HTTP | The server signs (Slack v0 HMAC, `X-Hub-Signature-256`, `Linear-Signature`, `X-Notion-Signature`) and POSTs to `endpoint`. It retries on a non-2xx response or a timeout, the way the platform does: Slack sends `X-Slack-Retry-Num` and `Retry-Reason`. Tests can force a retry with `delivery.retry({ after: "3s" })` (Slack) or `delivery.redeliver()` (GitHub, Linear) |
| Fake, Slack Socket Mode | The fake implements `apps.connections.open`, a WebSocket endpoint, envelopes and acks. Many Bolt and Pi apps use Socket Mode |
| Live | The real platform delivers to the agent directly; how the agent is reachable is the agent's concern. channelstack acts on the platform and reads results back. It never relays or synthesizes deliveries to the agent, so delivery chaos is fake-only. GitHub's delivery log can still be read. Spec: [live-mode.md](live-mode.md) |

Every delivery goes into the session event log with status, latency and the agent's response. A test can then assert "the agent acked within 3 s" or "a retry was received exactly once" without the server deciding anything.

## 7. Transcripts: what a person would see

This is the piece nobody else has, and it's why tests read like product requirements. Each driver renders its platform's state into a human-view model. The model applies the platform's own display rules; it isn't the raw API state.

**Slack thread transcript.** Each message carries:

- `from` (display name and whether it's a bot) and `text`
- Block Kit rendered to plain text, plus a structured list of `actions`
- `status`: `streaming | final | deleted`
- `edits` (count and history), `reactions`, `files`
- `ephemeralFor`: which users see it

The thread also carries the assistant status line (`assistant.threads.setStatus`) with its timing. Stream chunks from `chat.startStream`, `appendStream` and `stopStream` collapse into one message, the way Slack shows them. A stream that was never stopped renders the way Slack renders it, which is how MDAC-220 ("lone Thinking ✓") becomes a one-line assertion.

**GitHub timeline.** Comments, reviews and review comments, check runs and their conclusions, labels, the reactions a person sees, commits, and merge state.

**Linear.** Issue comments plus the agent session panel: activities (thought, action, response, error, elicitation), plan, state, and `externalUrl`.

**Notion.** The page as blocks rendered to text, its comments and discussions, and page property values.

Live and fake produce transcripts from the same renderer: live fetches real state through the API, then renders. **The differential test (section 9) compares transcripts, not raw JSON.** That comparison is what proves the fake right where it matters.

## 8. Drivers

### 8.1 Driver contract (server-side TypeScript)

```ts
export interface Driver<Cfg> {
  name: "slack" | "github" | (string & {})
  routes(r: DriverRouter): void              // control API, zod-openapi; becomes the SDK surface
  fake: FakeBackend                          // provider API emulation: Hono app + session store
  live: LiveBackend                          // real API client + cleanup handlers
  inbound: InboundAdapter                    // sign + deliver (fake); verify + observe (live, via recorder)
  transcript: TranscriptRenderer             // state → human view, shared by fake and live
  hosts: string[]                            // hosts the proxy routes to this driver's fake
  capabilities(): CapabilityTable            // per action: fake/live/liveRequires
}
```

- Every control action is written once against a `World` interface that both backends implement. For example, `world.postAsUser(user, channel, text)` is a store write and a signed event in the fake, and `chat.postMessage` with the user's token in live. That's what keeps the two realities from drifting apart in the code.
- New platforms are a new folder under `server/src/drivers/`, so core never changes for a new driver.
- Third-party drivers come later. Since the server is a binary, they'd need a plugin-loading story (a Bun-loaded TS module path). It's deliberately out of scope until four in-tree drivers prove the contract.

### 8.2 Our own fakes (decision D1, decided)

channelstack builds every fake itself and stays independent of emulate:

- **Not layered on another emulator.** The fakes are channelstack's own implementation, not `@emulators/*` apps with overrides. Ordinary libraries are used wherever they make sense (AGENTS.md, "Dependencies").
- **No copied code.** emulate (Apache-2.0) may be read as a reference for how a platform behaves, like any public documentation, but none of its code is copied, so channelstack's license is free to choose.
- **The sources of truth are the platforms themselves:** their API docs, published schemas (GitHub's REST description and webhook schemas, Linear's GraphQL schema), recorded live traffic, and the nightly differential run (section 9).
- **One store design for all four drivers.** Each `FakeBackend` is a Hono app over an in-memory store with seeding, reads for transcripts, and a delivery hook into the core's delivery queue. Phase 0 locks this interface with the `echo` driver.

### 8.3 Driver scope by milestone

**Slack (phases 1 and 2)**
- Objects: app (manifest), users, channels (public, private, DM, MPIM), threads.
- Actions, on `SlackUser`: `say(text, { channel } | { to })`, `reply(text, { thread })`, `react(emoji, { message })`, `edit`, `delete`, `click(label, { message })`, `select`, `runCommand("/cmd", { channel })`, `stop({ thread })`, `waitForModal()` then `modal.submit(values)`, `openAgentThread()`. On the fixture: `createUser`, `createChannel({ participants })`, `uninstallApp`.
- Fake API: `chat.*` including streams, `conversations.*`, `users.*`, `reactions.*`, `views.*`, `assistant.threads.*`, `auth.test`, files v2 (basic), Socket Mode.
- Live (phase 5): user tokens, and the browser actor for click, Stop and modal submit.

**GitHub (phase 3)**
- Objects: app, org, repo (ephemeral), users, issues, PRs.
- Actions, on `GitHubUser`: `openIssue({ title }, { repo })`, `comment(text, { issue })`, `openPullRequest({ from, changes }, { repo })` (pushes a branch through the Git Data API), `push`, `review({ pr, event, comments })`, `reviewComment(text, { pr, path, line })`, `reply(text, { comment })`, `requestReview`, `label`, `close`, `merge({ pr })`, `rerun({ checkRun })`. On the fixture and repo: `createRepo({ apps: [github.app] })`, `repo.installApp`, `repo.uninstallApp`. On a delivery: `redeliver()`.
- Fake: the REST surface used by Probot, Octokit and MDA. GraphQL for the queries those agents actually use comes later, found through recordings. Webhooks with GUID `X-GitHub-Delivery`. Check runs and statuses.
- Live: an App on a test org plus machine-user PATs. Repos are created per session and deleted at teardown.

**Linear (phase 4)**
- Objects: workspace, team, users, issues, agent app.
- Actions, on `LinearUser`: `createIssue({ title }, { team })`, `comment(text, { issue })` (an `@agent` mention opens a session), `delegate(linear.app, { issue })`, `prompt(text, { session })`, `answer(text, { elicitation })`, `stop({ session })` (live: browser actor). On the fixture: `createUser`, `createTeam`.
- Fake: GraphQL validated against Linear's introspected schema. Every response is checked against that schema in channelstack's own tests. Signed `AgentSessionEvent`, `Comment` and `Issue` webhooks, and the 10-second first-activity rule exposed as a delivery fact.

**Notion (phase 4)**
- Objects: integration, workspace, teamspace page, databases and data sources (API version `2025-09-03`), users, pages, comments.
- Actions, on `NotionUser`: `createPage`, `edit({ append }, { page })`, `setProperty(name, value, { page })`, `comment(text, { page, anchor? })`, `mention(notion.app, { page })`, `reply(text, { discussion })`, `connect(notion.app, { page })`. On the fixture: `createUser`, `createPage({ connections: [notion.app] })`, `createDatabase`.
- Fake: the REST surface Notion SDK clients use. Webhooks for `page.created`, `page.content_updated`, `page.properties_updated`, `comment.created` and `data_source.*`, signed `X-Notion-Signature` (HMAC-SHA256 with the subscription's verification token), plus the verification handshake.
- Fake realism to model:
  - `page.content_updated` is batched: delivery is delayed and aggregated, and the delay is configurable so tests don't hang.
  - Payloads are sparse, so agents have to fetch.
  - `comment.created` needs the comment-read capability.
- Live (phase 5): the integration token, plus person actions with each person's personal access token. "Add connections" needs the browser actor; resolving discussions is not yet supported live.

### 8.4 Ordering rationale

1. **Slack first.** It's where the closed stack hurt most, where the AI-specific surfaces (streams, assistant, Stop) are unfaked, and where Chat SDK, Pi and MDA all meet.
2. **GitHub next.** It has the best live API: almost every action works with a token, so it proves the differential loop cheaply.
3. **Linear and Notion together.** Both need spikes on the live side.

### 8.5 Browser actor (live-only fallback)

Some live actions only exist in the UI: Slack button clicks, Stop and modal submit, possibly Linear and Notion person actions. For those, a real user can be given a browser session:

```ts
const ana = await slack.createUser({ name: "Ana", token, browser: { storageState: ".auth/ana-slack.json" } })
await ana.click("Approve", { message: msg })   // live: drives app.slack.com via WebdriverIO BiDi; fake: signed block_actions
```

- The server owns a WebdriverIO BiDi session per browser actor, and each driver ships page objects for its platform's UI. This is WebdriverIO's home ground and is the main reason to keep it in the server rather than the SDKs.
- Sign-in is unattended, so it runs in CI: a passkey through WebDriver's virtual authenticator on GitHub and Linear, the emailed code from a test inbox on Slack and Notion. The session is saved and reused; it signs in again only when `channelstack doctor` finds it expired. channelstack never handles account passwords. Details: [reality-matrix.md, "Signing in without people"](reality-matrix.md#signing-in-without-people).
- **Risk:** UI selectors break. That's acceptable because it's live-only and nightly, and fake mode covers the same flow on every PR.

## 9. Proving the fakes against the real platforms

"Verify everything by running e2e tests against the real integrations" becomes four mechanisms.

### 9.1 Differential scenario runs

- **Scenario suite.** `scenarios/` is a suite of scenarios per driver, written once against the TypeScript SDK and run against reference agents.
- **Fake vs live.** CI runs each scenario twice, fake and live (nightly, and on demand with a label), and diffs the **normalized transcripts** and the **event sequences**.
- **Normalization.** It drops ids, timestamps and URLs, keeps structure and order, and compares LLM-free text exactly, which is why the reference agents use deterministic models.
- **Classifying differences.** Any difference fails the nightly and opens a tracking issue with both transcripts. Each difference is then either fixed in the fake, or marked a known divergence in `conformance/divergences.yaml` with a reason and an expiry date.

### 9.2 Record, then diff shapes

- In live runs, the proxy records every agent↔platform exchange and redacts tokens, emails and names.
- A shape differ replays each recorded request against the fake and compares the response *shape*: keys, types, enum values and error codes.
- This catches drift in endpoints that no scenario asserts on directly.

### 9.3 Spec validation of the fake's own output

Every fake response in channelstack's own test suite is validated against the platform's published schemas:

| Platform | Schema source |
|---|---|
| GitHub | `github/rest-api-description` (REST); `octokit/openapi-webhooks` (webhook payloads) |
| Linear | The introspected GraphQL schema, re-fetched weekly |
| Notion | Its OpenAPI, if published (verify); otherwise the recorded cassettes |
| Slack | Recorded cassettes only. Slack's own specs are stale |

### 9.4 Published coverage page

Each release generates a coverage page from the capabilities tables, divergences and nightly results. For each action and endpoint it shows whether it's implemented in fake, in live, and when it last agreed live. This is the public answer to "how do you know the fake matches Slack?", the question every twin vendor dodges.

### 9.5 Live test infrastructure we own

| Platform | Test infrastructure |
|---|---|
| Slack | Developer sandbox workspace, 2 test users with user tokens, 1 reference app. Sandboxes expire after about 6 months, so we track renewal |
| GitHub | `channelstack-e2e` org, a GitHub App, 2 machine users |
| Linear | Free test workspace, 2 users, the agent app |
| Notion | Test workspace, integration, 2 users with personal access tokens and unattended browser sign-in |

- **Secrets** live in CI environment secrets for a protected `live` environment. Fork PRs never get them.
- **Budgets:** live jobs are rate-limit aware (Slack tier limits) and run serially per platform.

## 10. Using it from each agent stack

The same three steps work for every stack: create the world, give the agent its environment, then act and read. What changes per stack is how the agent gets its environment.

| Stack | How it plugs in | Notes |
|---|---|---|
| **MDA** | Proxy mode against `mda-local up`. The Trigger Server receives real-format signed deliveries | Replaces the closed stack's `--fake-*` flags, `MDA_*_API_URL` overrides and patches 0008/0009. Scripted directive model fixtures stay. Port 3 scenarios first: DM → single reply (MDAC-220), button approval, Stop |
| **Chat SDK** (`chat` with `@chat-adapter/slack`, `/github`, `/linear`, `/notion`) | `channelstack env` provides `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and the GitHub/Linear/Notion equivalents. Endpoint is `/api/webhooks/{platform}`. Base-URL mode if the adapter accepts an API URL (verify per adapter), otherwise proxy mode | Recipe: Next.js route plus a Vitest file. Chat SDK's own matchers test adapter calls; channelstack tests the platform result |
| **AI SDK** (agent loop) with Bolt, Octokit or the Notion SDK as the channel | Base-URL mode. The model is `MockLanguageModelV2`/V3 from `ai/test` or emulate's AI service | Example: a Bolt app that streams an AI SDK response with `chat.startStream`. That's exactly the surface no one fakes today |
| **Pi** (`@mariozechner/pi-coding-agent` SDK) | Socket Mode fake or base URL; deterministic model through pi-ai's provider configuration | Example: "a DM to mom gets a threaded reply and a reaction" |
| **Bolt and Probot** (no AI) | Base URL or proxy | Shows channelstack isn't only for AI agents, and widens the audience |

Each stack gets a runnable example under `examples/agents/<stack>/` that CI exercises in fake mode on every PR. Those examples double as the reference agents for the nightly live runs, so the docs can't rot.

## 11. SDK generation

### 11.1 Why our own generator

Stainless, Speakeasy, Fern and openapi-generator all produce flat clients, like `client.slack.users.say(sessionId, userId, body)`. We want handle objects: `ana.say("hi", { to: slack.app })`, where `ana` came from `slack.createUser(...)`. They also cost money (Stainless, Speakeasy) or produce poor code (openapi-generator). The surface is small: tens of routes, not thousands. So the plan is a small in-repo generator.

### 11.2 Pipeline

```
server routes (zod-openapi) ──► spec/openapi.json ──► spec/ir.json ──► codegen/<lang> ──► sdks/<lang>
                                  (committed)          (committed)       (templates)        (generated + thin runtime)
```

**OpenAPI extensions** make the handle model explicit:

| Extension | Meaning |
|---|---|
| `x-channelstack-resource: { id?, scope? }` on a schema | Values of the schema are handles; `id` names the identifying field |
| `x-channelstack-ref: [SlackChannel]` on a request field | The field takes a handle and sends its id |
| `x-channelstack-method: { on: SlackUser, name: say, args: [text], options: [channel, to] }` | Binds an operation to a method on a handle. Path parameters bind to the handle's session and id; `args` become positional parameters and `options` the trailing options object (`ana.say(text, { channel })`) |
| `x-channelstack-factory: { on: SlackFixture, name: createUser }` | Declares a factory method |
| `x-channelstack-error-codes` | Lists the error codes an operation can return |
| `x-channelstack-stability` | `experimental` or `stable` (section 4.5) |

The exact shapes, with the IR they produce, are in [architecture.md](architecture.md) 5.2.

**The IR** is a language-neutral description of resources, methods, arguments, return types, enums and errors. Emitters only read the IR.

**Thin hand-written runtime per language:**

- **Transport:** an HTTP client with a bearer token, retries on connection refused while the server starts, and an error-code to exception map.
- **Launcher:** runs the integration's `mode` (`auto`, `attach` or `start`). It first looks for a running server at `https://channelstack.localhost` (or `CHANNELSTACK_URL`) and attaches to it. Otherwise it finds the server binary, starts it, waits for `/status`, and stops it on exit. Attaching is the normal local case: the server you're already chatting with in the UI also runs your tests.
- **Credential lookup:** reads env vars and attaches them to calls.

### 11.3 Per-language idioms

| Language | Style |
|---|---|
| TypeScript | `async` methods; ESM and CJS builds; types from the IR (checked against the hand-designed `api/*.d.ts`); fixtures and matchers through `channelstack/vitest` and `channelstack/jest`; created resources implement `AsyncDisposable` for use outside fixtures |
| Python | Async-first (`httpx`) with a sync facade; Pydantic models; `pytest-channelstack` fixtures (`slack`, `github`, `linear`, `notion`); `await ana.say("hi", channel=channel)`; snake_case |
| Rust | `reqwest` + `serde` + `tokio`; builder structs for optional arguments; `Drop` handles cleanup best-effort, plus an explicit `close().await` |

### 11.4 Keeping SDKs honest

- `scenarios/smoke/` contains about 10 protocol scenarios written in a tiny YAML step format. Each SDK's CI translates and runs them through that SDK. That's our version of WebDriver's WPT: every language is proven to drive the same protocol identically.
- CI fails when the committed `openapi.json`, `ir.json` or generated SDKs are stale.

### 11.5 Distribution

- **Server binary:** `bun build --compile` for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and windows-x64.
- **npm:** `@channelstack/server-<platform>` as optionalDependencies of `channelstack`, the esbuild pattern.
- **PyPI:** wheels per platform with the binary bundled, the ruff pattern.
- **Rust:** downloads the release binary on first use, with checksum verification, or uses `CHANNELSTACK_SERVER_BIN`.
- **Docker:** `ghcr.io/<org>/channelstack` for CI and for proxying Go or Linux agents.
- **Releases:** one tag releases the server, the spec and every SDK at the same version.

## 12. Security

channelstack holds real tokens and can post into real workspaces, so these are requirements, not polish:

1. **Control API binding.** The server listens on loopback only, and portless serves it at `https://channelstack.localhost` (portless itself listens only on `127.0.0.1` and `::1`). On start the server generates a random bearer token and writes it to `~/.channelstack/server.json` with mode 0600. The CLI, MCP server and test integrations read it from there, or from `CHANNELSTACK_TOKEN`. The UI gets a one-time login link on start, which sets an `HttpOnly`, `SameSite=Strict` cookie. Tokens are compared in constant time. `--host 0.0.0.0` (Docker) requires an explicit `--token`.
2. **Live allowlist.** Live mode is refused unless the workspace, org, team or Notion workspace id is in `CHANNELSTACK_LIVE_SLACK_TEAMS`, `CHANNELSTACK_LIVE_GITHUB_ORGS`, `CHANNELSTACK_LIVE_LINEAR_WORKSPACES` or `CHANNELSTACK_LIVE_NOTION_WORKSPACES`. A token that leaks into a test can't post into the company Slack.
3. **Fake actors stay out of live worlds.** This is enforced in core, not in each driver.
4. **Cleanup ledger.** Every live resource gets a `channelstack-run-<id>` tag in its name or description and is recorded in the ledger. Teardown deletes in reverse order. `channelstack sweep` removes leftovers older than 24 hours from crashed runs, and only touches resources carrying that tag in allowlisted workspaces.
5. **The fake checks signatures like the real platform.** It verifies the agent's tokens and the session's signing secrets. HMAC is computed over the raw body bytes and compared in constant time, so the fake rejects what the real platform would. Fake secrets come from a CSPRNG once per install and live in `~/.channelstack/secrets.json` (mode 0600), so they stay stable across restarts. There are no hard-coded defaults, and `channelstack secrets rotate` replaces them.
6. **CA hygiene.** The CA has a per-install key with mode 0600 and name constraints limited to the routed provider hosts. It's never installed system-wide, and trust is injected only into the agent's environment. `channelstack ca rotate` replaces it.
7. **Redaction.** Recordings, logs and error messages redact tokens, signing secrets, emails and user names before writing. Cassettes committed to the repo pass a redaction lint in CI.
8. **Browser actors.** Storage state stays local, with mode 0600, and is never uploaded. channelstack never types passwords.

## 13. Repository layout

```
channelstack/
  server/                    Bun + Hono + @hono/zod-openapi
    src/core/                sessions, registry, ids, secrets, signing, reality rules, event log, delivery, errors, redaction, safety, ledger, proxy, ca, recorder (docs/code-map.md names the module for each)
    src/drivers/{echo,slack,github,linear,notion}/
      routes.ts  world.ts  fake/  live/  payloads.ts  transcript.ts  capabilities.ts
    src/cli.ts               channelstack [start] | env | doctor | reset | mcp | <channel> <action> --as … | deliveries | redeliver | tail | show | login | sweep | ca | secrets
  ui/                        the functional browser UI (transcript view, inspector, chaos controls), served at channelstack.localhost
  spec/                      openapi.json, ir.json (generated, committed)
  codegen/                   ir builder + emitters/{ts,python,rust}
  api/                       hand-designed public types (*.d.ts) + examples; the generated TS SDK must satisfy them
  sdks/{typescript,python,rust}/   runtime/ (hand-written) + generated/ (Python: inside the `channelstack` package)
  integrations/              vitest, jest (TS) · pytest-channelstack (Python) · checks (standard behaviour checks)
  scenarios/                 smoke/*.yaml (protocol parity), runners/, agents/ + <driver>/*.test.ts (differential suite)
  scripts/                   the gate, spec and SDK generation, the binary build, packaging and smoke runs
  conformance/               schema validators, shape differ, divergences.yaml, coverage page generator
  examples/agents/{bolt-ai-sdk,chat-sdk-slack,chat-sdk-github,probot,linear-sdk,notion-sdk,mdac-220,mda}/
  docs/
```

## 14. Milestones

Replaced by [phases.md](phases.md): nine phases, each with a gate (`pnpm verify:phase <n>`) of automated exit checks.

## 15. Decisions for you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Wrap emulate's fakes, or write our own | **Decided:** our own fakes, no dependency on emulate (section 8.2) |
| D2 | Own SDK generator or Stainless/Fern | **Decided:** own generator. The handle model and the small surface make it cheaper than bending a vendor's output |
| D3 | Browser actor engine | **Decided:** WebdriverIO BiDi inside the server |
| D4 | Path prefix `/sessions/{sid}/slack/...` or `/slack/...` plus a session header | **Decided:** path prefix. It's explicit and greppable, and it mirrors WebDriver |
| D5 | License | **Open.** MIT recommended: channelstack is independent of emulate, and MIT matches WebdriverIO |
| D6 | Repo home | **Decided:** [christian-bromann/channelstack](https://github.com/christian-bromann/channelstack) (private for now) |

## 16. Risks

| Risk | Mitigation |
|---|---|
| emulate adds streaming, proxying and assertions first | Our edge is live parity, transcripts and the coverage evidence, not the fakes. channelstack stays independent either way |
| Live infrastructure decays: sandbox expiry, token rotation | A nightly preflight job checks every credential with `auth.test` and the other checks from section 5, and pages before scenarios fail |
| Browser-actor flakiness | Live-only and nightly. Retries are allowed only on the UI step, with screenshots and BiDi logs attached |
| Notion person actions turn out impossible through the API | The browser actor, or scope Notion live to integration-to-integration flows at first |
| Protocol churn breaks generated SDKs | Experimental vs stable route marking, a major-version check on connect, and smoke parity per SDK |
| Rate limits make live runs slow | Serial live jobs per platform, minimal scenario set live, the full set fake |
| Scope across four platforms in six weeks | Each milestone's exit criterion is the cut line. Anything not green moves to the fast follows; we don't stretch the milestone |

## 17. First week

See phase 0 in [phases.md](phases.md).

## Sources for facts added in this plan

- Notion webhooks, signatures and event batching: https://developers.notion.com/reference/webhooks , https://developers.notion.com/reference/webhooks-events-delivery , https://hookdeck.com/webhooks/platforms/guide-to-notion-webhooks-features-and-best-practices
- Chat SDK adapters (including Notion) and webhook routes: https://vercel.com/docs/chat-sdk/adapters , https://chat-sdk.dev/docs/vercel-connect
- Pi SDK and `pi-mom`: https://cdn.jsdelivr.net/npm/@mariozechner/pi-coding-agent@0.73.1/README.md , https://agentic-ai.readthedocs.io/en/latest/AgentHarness/pi-dev/
- Everything else comes from `docs/research/track1-4` and the closed MDA stack analysis.
