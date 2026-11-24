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
| Listening, the token file, portless names | `serve.ts` | `start`: loopback bind, `server.json`, alias registration, upgrading a WebSocket a fake expects (`app.socket`) | Call `Bun.serve` anywhere else (everything else also runs under Node) |
| The command line | `cli.ts` | Parsing arguments and dispatching: `start`, `secrets rotate`, `doctor`, `sweep`, `--version`, and the attach commands below | Read `process.argv` or `process.env` flags in core |
| Live mode from the terminal | `cli/live.ts` | `doctor` (which channels run live, whether their credentials work and are allowlisted, saved browser sessions), `sweep` (what crashed runs left, `--check` for the nightly job) and `login` (a person signs in by hand, once; the session is saved for the browser actor), over each driver's `live.maintenance` | Call a platform from the CLI without the driver's maintenance |
| Attaching to a running server | `cli/attach.ts` | Finding the server (`--server`, `CHANNELSTACK_URL`, `server.json`), calling the control API, the shared `dev` session, `CliError` | Read `server.json` or call the control API from another CLI module |
| Acting from the terminal | `cli/slack.ts` | `slack say`, `reply`, `react`, `click`, `stop`; people and channels by name, created on first use; what `last` means | Resolve names or `last` anywhere else |
| Watching from the terminal | `cli/watch.ts` | `show` (a transcript as text or JSON) and `tail` (deliveries and API calls as they happen) | — |
| The UI page in the binary | `ui/page.ts` (the page itself is `ui/index.html`) | Importing the page as text, for the binary's entry only | Import it from `app.ts`: the app takes the page as an option, so it also runs under Node |
| The list of drivers | `drivers/index.ts` | `DRIVERS`, `secretSpecs()` | Import a driver from core |

## Server: core (`server/src/core/`)

| Concern | Module | Use it for | Don't |
|---|---|---|---|
| Sessions and ownership | `sessions/` | Opening and closing scopes, `onClose` cleanup; sessions shared by name (`dev`, for the CLI, the UI and MCP) | Track ownership inside a driver |
| Object registry and handles | `registry/` | Typed collections per driver and type; resolving handle ids for a session (`get`), from the platform's side (`find`), and their owner; a session's objects, or all of them, in the order they were made (`list`, `values`) | Keep a private `Map` of objects in a route |
| Ids in each platform's format | `ids/` | Every generated id (`U…`, `C…`, `ts`, GitHub numbers and node ids, UUIDs), seeded by `CHANNELSTACK_SEED`; validating fixed ids (`reserve`); reading the time out of a Slack `ts` (`slackTsTime`) | Call `crypto.randomUUID()` or format ids by hand |
| Secrets | `secrets/` | Fake tokens and signing secrets (the CSPRNG helpers, the token formats, `~/.channelstack/secrets.json`, 0600, rotation); live credentials in memory (`live.ts`: `LiveCredential`, which never turns into text, and `LiveVault`, which registers each with the redactor) | Generate or store a secret anywhere else; hold a live token as a plain string |
| Signing and verification | `signing/`, one file per platform, `hmac.ts` shared | HMAC-SHA256 over the sent bytes, constant-time compare (`constantTimeEqual`); the echo signer; Slack v0 (`slack.ts`); GitHub's `X-Hub-Signature-256` and checking an App's JWT (`github.ts`); `Linear-Signature` and the `webhookTimestamp` stamped into the body (`linear.ts`); `X-Notion-Signature` with the verification token (`notion.ts`) | Compute an HMAC or compare a secret in a driver |
| Access to the control API | `auth/` | Creating the bearer token, parsing `Authorization: Bearer`, the middleware (`requireAccess`); browser access for the UI (`ui.ts`): one-time login codes, the session cookie, and the short list of reads it allows | Compare tokens with `===`; let a cookie authorize anything but those reads |
| Event log and cursors | `events/` | Appending deliveries, API calls and actions (`EventLog`); what belongs to no session, in a scope every session reads (`WORLD_SCOPE`); cursor-based reads of any list (`CursorList`) | Keep per-driver logs or invent another cursor format |
| Delivery queue | `delivery/` | Sending events to the agent over HTTP with the platform's signer and ack window; keeping every delivery with its attempts; sending one again (`again`: a platform's retry headers, a forged signature); a platform's own retries (`RetryPolicy`, on the injected timers); another way to the agent than HTTP (`DeliveryTransport`: a connection the agent opened); handing the agent's answer to the driver (`answered`); putting the attempt into the signed body (`stamp`: its time, its number); cancelling a closed session's deliveries. | Call `fetch` to the agent from a driver |
| Quiet detector | `quiet/` | "Is the agent idle, and for how long?" (`GET /sessions/{sid}/quiet`): busy while a provider call is in flight, a delivery is in flight or about to be retried, a driver reports open work (named, so a failure can say what was left open), or the agent was told to retry later (`expectMore` until it `arrived`); negative and exact-count matchers wait for it | Add sleeps or ad-hoc settle timers |
| Reality rules | `reality/` | Fake or live per driver from its declared credentials and `CHANNELSTACK_REALITY` (`driverReality`); how a route works live (`LiveSupport`, `DELIVERY_IS_THE_PLATFORMS`); refusing what doesn't (`admitLive`, called by `DriverRouter`), `unsupported_in_live`, `action_requires` (a test skips), `live_misconfigured` (a test fails), `fake_actor_in_live_world`; a real account's roles against what a test asks for (`checkRoles`) | Branch on `process.env` credentials in a driver; refuse a fake-only operation in its handler instead of declaring it |
| Live maintenance | `maintenance/` | What `channelstack doctor` and `sweep` do for every driver: a driver's live credentials in the environment, each identified (`liveCredentials`); doctor's line per credential through the live world's own check (`credentialChecks`); the ledger's part of a sweep (`sweepLedger`) and the tagged part, which leaves out what a ledger lists (`sweepTagged`) | Read `CHANNELSTACK_*_USER_*` variables, or loop over a ledger, in a driver's `maintenance.ts` |
| Live people | `people/` | The real people of a live world's open sessions (`LivePeople`), in all four live worlds: each session holds the people of the shared pool it created, with their credential and its name for them; only a session that holds a person acts as them (`actingAs`), nobody takes them from another session, and they go when the last session holding them closes | Keep a person's token or record per session in a live world |
| Safety | `safety/` | The `CHANNELSTACK_LIVE_*` allowlists (`Allowlist`, `live_not_allowlisted`), the run tag in live names (`runTag`, `taggedRun`, and the names a live world gives what it makes, `taggedNames`), the run id (`runId`, `CHANNELSTACK_RUN_ID`) | Check a workspace id against an allowlist by hand |
| Browser actor | `browser/` | A real browser driven as a person (WebdriverIO, Chrome over BiDi) for what only a platform's client does: `BrowserActor` (opens only its origins, restores a saved session), `BrowserActors` (one browser per person for the whole server, shared by the sessions that need them, each action in turn through `exclusive`; closed with the last session, saving the cookies a platform renewed while it is still signed in, `KeepSession`), saved sessions (`readStorageState` refuses one others can read, `writeStorageState`, `storageStatePath`) | Start a browser anywhere else, or keep a session's cookies outside these files |
| Cleanup ledger | `ledger/` | What live sessions created, removed newest first when the session closes (each driver's `onCleanup`); one file per server, read by `channelstack sweep` after a crash (`readLedgers`, `rewriteLedger`) | Delete live objects from a driver directly, or keep a list of them anywhere else |
| `RichText` | `rich-text/` | Splitting a test's text at its `@name` mentions (`richTextPieces`); each driver turns the pieces into its own mention | Parse `@name` in a driver |
| Errors | `errors/` | The protocol's error codes and their HTTP status (`ProtocolError`), including a platform's own refusal surfaced through the control API (`{ platform, status }`) | Throw ad-hoc error shapes from routes |
| Redaction | `redact/` | Scrubbing tokens, secrets and emails from logs and errors (`text`), and tokens from recorded payloads (`tokens`) | Log request bodies or headers without it |
| Logging | `log/` | The one logger: JSON lines, redacted | Write to stdout or stderr from core or a driver |
| What every fixture lets a test inspect | `router/inspect.ts` | The schemas and reads every channel shares: `DeliveryAttempt`, `DeliveryStatus`, a channel's API call schema and the `calls()` filter (`apiCallSchema`, `CallsQuery`, `readCalls`); putting a call on record for its sessions, or for none (`recordCall`, the one writer); a transcript's entry type, schema and text (`TranscriptEntry`, `principalSchema`, `transcriptSchema` with a channel's extra fields, `transcriptText`); `duration` | Declare a delivery attempt, an API call schema, a transcript entry or its schema in a driver; append an `api_call` event yourself; join a transcript's lines yourself |
| Routing helpers | `router/` | `registerRoute`, `DriverRouter` (which refuses on a live driver what its route declares it can't do live), zod-openapi registration, `x-channelstack-*` extensions; the `Driver`, `DriverContext`, `FakeBackend` and live contracts (`LiveContext`, `LiveMaintenance`) | Register Hono routes on the control API without the extensions |
| State directory | `home/` | `CHANNELSTACK_HOME`, writing 0600 files atomically, reading JSON state | Write a file with a secret any other way |
| Time | `clock/` | The injected clock, and injected timers (`Timers`, `delay`) for anything that happens later: a platform's retry, a pause, a fault's latency; the server's one polling loop (`pollUntil`: ask until there is an answer or the time is up) | Call `Date.now()` or `setTimeout` in core or a driver; write a deadline-and-poll loop |
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
| `mentions.ts` (Slack) | `@name` in a test's text → the platform's mention syntax, and back (`nameMentions`, `splitAtMentions`); Slack's stored text as a person typed it, links unwrapped and `&`, `<`, `>` unescaped (`typedText`); an emoji's name (`emojiName`) |
| `live/` | The driver on its real platform. Slack: `client.ts` (Web API calls with one credential, form-encoded, 429s), `identity.ts` (who a token is, and the one check of the app's and a person's credential: kind, workspace, allowlist), `world.ts` (the live `SlackWorld`: people act with their tokens, reads cached for a second, what the session made mirrored), `cleanup.ts` (archiving a channel, deleting a session's DM messages and the replies under them, the tagged channels a sweep finds), `maintenance.ts` (`doctor`, `sweep` and `login`'s sign-in page, from the environment's credentials), `ui.ts` (Slack's web client as the browser actor drives it: typing a message or a reply with mentions, clicking a button; its selectors in one place) |
| `payloads.ts` | Builders for every event payload this platform sends (used by the fake's delivery) |
| `interaction-payloads.ts` (Slack) | Builders for what Slack sends when a person acts in the client: `block_actions`, `message_action`, slash command fields; a person's handle (`handleOf`) |
| `blocks.ts` (Slack) | Reading Block Kit: the text and controls a person sees, finding a button or a menu by label or `action_id`, filling in missing `block_id`s and `action_id`s |
| `views.ts` (Slack) | Reading a modal as a person does: its inputs by label, what is filled in, `state.values` |
| `fake/views.ts` (Slack) | Modals: `views.open` / `update` / `push`, and a person submitting or closing one. Part of the fake world |
| `fake/socket.ts` (Slack) | Socket Mode: tickets from `apps.connections.open`, the app's connections, envelopes and acks. It is the delivery queue's transport once the app connects |
| `fake/interactions.ts` (Slack) | What a person does beyond writing: clicks, menu choices, shortcuts, slash commands, Stop, the agent split view, and the app's answers through `response_url`. Part of the fake world |
| `fake/kit.ts` (GitHub) | What the parts of the GitHub world build on: permissions (`can`, `allow`), sending a webhook (`emit`, with GitHub's headers), `GitHubRefusal`, the git identity of a person |
| `fake/git.ts` (GitHub) | Git in memory with real SHAs (isomorphic-git on memfs): blobs, trees, commits, branches, history, merges, and what changed between two commits with patches |
| `fake/repos.ts`, `issues.ts`, `pulls.ts`, `checks.ts` (GitHub) | The GitHub world, one file per area: people, repositories and pushes; issues, comments, labels, reactions; pull requests, reviews, threads, merging; check runs and statuses. `fake/world.ts` puts them together and owns deliveries |
| `schema/` (Linear) | Linear's GraphQL schema: `schema.graphql` from `linear/linear` at a pinned commit, and `schema.ts`, the module the binary embeds (generated) |
| `fake/graphql.ts` (Linear) | Running GraphQL against Linear's committed schema (`schema/`, from `scripts/linear-schema.ts`): the field resolver over model objects, the depth limit, Linear's errors (`LinearError`, `notFound`), connections and filters |
| `backend.ts`, `text.ts` (Linear) | The `LinearWorld` both worlds implement (actions, and the store the routes read); mentions as profile links, a comment's thread and an issue's state, from either world's records |
| `live/` (Linear) | `client.ts` (GraphQL with one credential, rate limits, `LinearRefusal`), `identity.ts` (the one credential check), `world.ts` (the live `LinearWorld`, with a `LinearStore` mirror refreshed before reads), `cleanup.ts` (deleting a team), `maintenance.ts` (`doctor`, `sweep`) |
| `backend.ts`, `reads.ts` (Notion) | The `NotionWorld` both worlds implement (actions, and the store the routes read); reading a workspace's records, for either world's store: titles, access through connections, blocks, Markdown, rich text with mentions, the block a text is in, discussions (`notionReads`) |
| `live/` (Notion) | `client.ts` (REST through `@notionhq/client` with one credential per call, paging, `NotionRefusal`), `identity.ts` (who a token is: the integration's, or a person's personal access token; the one credential check), `world.ts` (the live `NotionWorld`: a session's pages in a tagged page of its own, a `NotionStore` mirror read again before reads), `cleanup.ts` (a page to the trash), `maintenance.ts` (`doctor`, `sweep`) |
| `fake/models.ts`, `fake/resolvers.ts` (Linear) | Records → the objects GraphQL resolves (issues, comments, sessions, activities, teams, states), and the root queries and mutations the app calls |
| `links.ts` (Linear, Notion) | Where a person would open something: issue, comment, profile and session URLs (Linear); page and database URLs (Notion) |
| `markdown.ts` (Notion) | Markdown → Notion blocks (with `marked`'s lexer) and blocks → Markdown |
| `errors.ts` (Notion) | Notion's API refusals (`NotionApiError`: status, `code`, message) and a list's paging as a request gives it (`pagingOf`) |
| `rich-text.ts` (Notion) | Notion's rich text items: text runs, mentions, plain text |
| `objects.ts` (Notion) | Records → the API objects Notion answers with (users, pages, blocks, databases, data sources, comments, property values, lists), typed by `@notionhq/client`'s response types |
| `backend.ts`, `fake/actions.ts` (GitHub) | The `GitHubWorld` both worlds implement for what works live (people, repositories, issues, comments, labels, assignees, reactions, files, the delivery log); the fake's implementation over its parts, with the permission checks real GitHub makes itself. Pull requests, reviews, pushes and checks use the fake's parts directly |
| `live/` (GitHub) | `client.ts` (Octokit as a person, the App's JWT or its installation, through `@octokit/auth-app`; the App's key checked before anything is sent; `GitHubRefusal`; which refusals pass, `passing`), `identity.ts` (the App and its installations, a person's token, and the one check of each: the test org, `testOrg`, and `checkGitHubPerson`), `world.ts` (the live `GitHubWorld`: the installation makes each session's tagged repositories, a `GitHubStore` mirror read again before reads, the App's delivery log as deliveries), `cleanup.ts` (deleting a repository), `maintenance.ts` (`doctor`, `sweep`) |
| `fake/api/` (GitHub) | The REST API the App calls, one file per area (`repos.ts`, `issues.ts`, `pulls.ts`, `checks.ts`), with authentication, the App's own endpoints and call recording in `index.ts`, and request helpers in `shared.ts` |
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
| Transport | `transport` | Bearer token, retries while the server starts, error code → typed exception, a hook that sees every refusal with its request path (`onRefusal` / `on_refusal`, for a test integration) |
| Launcher | `launcher` | `auto` / `attach` / `start`; finding the server binary and its per-platform package name |
| Client base | `client` | What generated handles share: `HandleContext`, the root client's `close`, the version check on connect |
| Credentials | `credentials` | A credential the test left out, from the environment: `CHANNELSTACK_SLACK_USER_{name}_TOKEN` with the person's name (`x-channelstack-credential` on the field) |
| Waiting and polling | `wait` | The one polling loop: cursor reads, timeouts, repeating a call a person would wait for (`retryWhile`), text matching for waits, quiet checks (`untilQuiet`; `watching` makes it look for the whole window, and a timeout names what the agent left open). Every `waitFor…`, `latest…` and matcher uses it |
| Durations | `duration` | Parsing `"3s"`, `"750ms"` |
| Files | `files` | Reading fixture files and directories a test hands over (`readTree`, `readChanges`), and where relative paths start (`setFilesRoot`) |

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
| The workflows the agents offer | `shared/workflows.ts` | A deploy that needs approval or an environment, the incident form, a ticket for a message, suggested prompts: the Block Kit and the words, the same for every agent |
| The Bolt app the Bolt agents start from | `shared/bolt.ts` | Configuration from the environment, `listen` |
| Bolt + AI SDK | `bolt-ai-sdk/agent.ts` | Mentions, DMs, reactions, native streaming |
| Chat SDK | `chat-sdk-slack/agent.ts` | The same behaviour on Vercel's Chat SDK and its Slack adapter |
| What the GitHub agents do | `shared/github.ts` | Triage, duplicates, the typo fix, reviews, thread answers, checks and the autofix, written once against Octokit's REST methods |
| The HTTP server around a web-standard handler | `shared/serve.ts` | For agents on frameworks that speak Request and Response (the Chat SDK) |
| Probot | `probot/agent.ts` | A GitHub App as Probot's docs show |
| Chat SDK on GitHub | `chat-sdk-github/agent.ts` | Conversations through the Chat SDK's GitHub adapter, the rest with `@octokit/webhooks` |
| A GitHub agent with one fault per standard check | `broken-github/agent.ts` | `BROKEN=<check id>`; exit check 3.4 proves each check fails against it |
| What the Linear agents do | `shared/linear.ts` | Acknowledge, start the issue, work, answer, review; a question first, a plan and a link, a long job that only Stop ends; written once against `LinearClient` |
| `@linear/sdk` | `linear-sdk/agent.ts` | `LinearWebhookClient` and `LinearClient`, as Linear's agent guide shows |
| Chat SDK on Linear | `chat-sdk-linear/agent.ts` | The Chat SDK's Linear adapter in agent-session mode; the rest with `LinearClient` |
| What the Notion agents do | `shared/notion.ts` | Answers in the discussion, action items, estimates, a mention in the body, a summary for a new page, a row set to "Ready for agent"; written once against `@notionhq/client` |
| `@notionhq/client` | `notion-sdk/agent.ts` | The verification request, `verifyWebhookSignature`, `Client` |
| Linear and Notion agents with one fault per standard check | `broken-linear/agent.ts`, `broken-notion/agent.ts` | `BROKEN=<check id>`; exit check 4.5 proves each check fails against them |
| An agent with one fault per standard check | `broken-slack/agent.ts` | `BROKEN=<check id>` switches on the bug that check exists to catch; exit check 2.3 proves each check fails against it |
| A deliberately broken agent | `mdac-220/agent.ts` | Leaves a lone "Thinking…" stream behind; exit check 1.4 proves the suite catches it |

## Scripts (`scripts/`)

| Concern | Module | Notes |
|---|---|---|
| The gate | `verify-phase.ts` | Standing checks, then the exit checks of phase 0..n; one group of them (`--group static|unit|accept`) and one acceptance part (`--part`, `--repeat`), as CI runs them side by side |
| Building the spec from the routes; comparing generated files | `lib/generate.ts` | Used by `spec.ts` and `sdk.ts` (write, or `--check`) |
| Build targets and where build output goes | `lib/packages.ts` | The five targets, `binaryPath`, the platform package directories. Package and binary names come from the SDK launcher |
| Running processes | `lib/process.ts` | `run`, `capture`, `background`, `freePort`. Waiting is `waitFor` from the SDK runtime's `wait` module, here too |
| What the Bolt delivery tests share | `server/test/integration/slack-fixtures.ts` | `slackSession` (a session with Ana and a channel on a running server) and `SUMMARY_VIEW` (a one-input modal) |
| A GitHub org for a unit test | `server/test/github-workspace.ts` | `githubWorkspace` (the App, a stand-in agent, a session with Ana and a repository; `api` calls the REST API as the installation and checks every answer against GitHub's description). New GitHub test files start from it |
| A Linear workspace for a unit test | `server/test/linear-workspace.ts` | `linearWorkspace` (the app, a stand-in agent, a session with Ana in a team; `gql` calls GraphQL as the app and holds every answer to Linear's schema) |
| Linear's schema as a validator | `server/test/linear-schema.ts` | `linearResponseProblems`, `linearWebhookProblems`: what a GraphQL answer or a webhook gets wrong by the committed schema. The unit tests and `test/acceptance/linear-schemas.setup.ts` use it |
| Linear's schema in the binary | `scripts/linear-schema.ts` | Writes `server/src/drivers/linear/schema/schema.ts` from the pinned `schema.graphql`; `--check` in the gate, `--fetch` for a new commit |
| GitHub's schemas as validators | `server/test/github-schemas.ts` | `restProblems`, `webhookProblems`: what a response or a webhook gets wrong by `@octokit/openapi` and `@octokit/openapi-webhooks`. The unit tests and `test/acceptance/github-schemas.setup.ts` use it |
| Real Linear in a unit test of live mode | `server/test/linear-live-stub.ts` | `linearStub`: a workspace in memory answering the GraphQL operations the live backend sends, by name; delegating opens a session, and `agentSays` plays the agent |
| Slack's web client in a unit test of the browser actor | `server/test/slack-client-stub.ts` | `slackClientStub`: answers what the actor does over the Slack stub; what is typed and sent arrives as a message a person typed, and clicks are recorded |
| Real GitHub in a unit test of live mode | `server/test/github-live-stub.ts` | `githubStub`: an org in memory with the App installed, answering the REST calls the live backend makes (the App's JWT signed with a real key it doesn't check), invitations accepted as each person, the App's delivery log; `agentComments` plays the agent |
| Real Notion in a unit test of live mode | `server/test/notion-live-stub.ts` | `notionStub`: a workspace in memory answering the REST calls the live backend makes, with Notion's attribution (a personal access token's pages are by its bot, its comments by its person) and visibility (the integration sees what is under its page); `agentReplies` plays the agent |
| Real Slack in a unit test of live mode | `server/test/slack-live-stub.ts` | `slackStub`: a workspace in memory that answers the Web API methods the live backend calls, in Slack's shapes, and records each call with whose token made it. Live tests hand its `fetch` and `apiBase` to `harness(…, { live })` |
| A Slack workspace for a unit test | `server/test/slack-workspace.ts` | `slackWorkspace` (the app, a stand-in agent, a session with Ana and a channel), `signedBy`. New Slack test files start from it |
| The app in memory, for unit tests | `server/test/app-harness.ts` | `harness` (the app called through `fetch`, no listener, with timers the test advances itself), `recordingAgent` (a stand-in agent endpoint) and `refusal` (the error code a control call was refused with). Every driver's unit tests use it |
| Starting a server executable for a test or a smoke run | `lib/server.ts` | `startBinary`: spawn, wait for the server file, collect output, stop. The SDK launchers have their own start, because they ship |
| The binary under test, with a control API client | `server/test/integration/harness.ts` | `BINARY`, `cli`, `startBinary` (adds `control` to `lib/server.ts`'s). Shared by the server's and the SDK's integration tests |
| Compiling the server | `build-binary.ts`, `bun-compile.ts` | `bun build --compile` (through `Bun.build`, with a plugin that makes WebdriverIO's computed imports literal so it bundles), one npm package per platform |
| Running the server from source | `dev-server.sh` | Stands in for the binary (`CHANNELSTACK_SERVER_BIN`) on machines that block freshly compiled executables. CI never uses it |
| Smoke runs against the binary | `smoke.ts`, `accept.ts` | Server and reference agent next to each SDK's runner; `--repeat` for the flake check; `--part` for one part of the acceptance suite (Slack; GitHub and Linear; Notion, every channel at once and the tests with their own agent; the checks against the broken agents, Slack's and the others') |
| A server next to a reference agent | `lib/stack.ts` | `withStack`: a private state directory, the binary, the agent with what `channelstack env` prints; `others` adds one agent per channel (every channel in one run); `serverEnv` gives the server alone live credentials. Everything that needs both uses it |
| `api/examples` against the reference agents | `examples.ts` | `runExamples`, and `ENABLED_TESTS`: the example tests this phase has built. Also runs `test/acceptance/stack`, each channel's checks, and `shared.test.ts` with one agent per channel |
| The examples against the generated SDK | `api-check.ts` | `pnpm api:check`: type errors in enabled tests fail; errors in tests of later phases are counted |
| A whole server against a stand-in platform | `test/acceptance/stand-ins/` | `github-live-server.sh`: the server from source with GitHub live against `githubStub`, through `start({ platforms })`, which only code can set |
| Acceptance tests that aren't examples | `test/acceptance/` | `stack/` runs with the examples' server and agent (quiet, parallel sessions); the files next to it bring their own agent (`mdac-220`, the CLI and UI with a browser) or their own server (`live-skip`, a live server whose refusals skip) |
| The live run | `live.ts` (`pnpm live`) | Every "live mode" block against the real sandboxes, Slack's agent in Socket Mode, then `sweep --check` for the run; nightly in `.github/workflows/live.yml` |
| The nightly job's credentials | `live-secrets.ts` (`pnpm live:secrets`) | Every secret and variable `live.yml` names, from `live.env` into the repository's `live` environment through `gh`, values on standard input, names only in its output; the saved browser sessions as `CHANNELSTACK_BROWSER_SESSIONS` |
| The live run's agents | `lib/live-agents.ts` | Each channel's reference agent against its real platform: Slack's in Socket Mode, the others behind the smee.io channel their webhook points at (`smee-client`); the people's saved browser sessions from `CHANNELSTACK_BROWSER_SESSIONS` |
| Packaging check | `pack-test.ts` | `npm pack` into an empty project |
| Stale-check self-test | `selftest-stale.ts` | Proves `spec:check` and `sdk:check` fail on drift |

## Test integrations (`integrations/`)

| Concern | Module | Notes |
|---|---|---|
| Matcher logic | `integrations/matchers-core/` | Framework-neutral matcher implementations built on the SDK's read methods and `wait`. Vitest and Jest adapt it; they don't reimplement matchers |
| Vitest | `integrations/vitest/` | Plugin (`index.ts`), attaching to or starting a server (`global-setup.ts`), a session and fixtures per test, registered with `test.override` so a suite's `test.extend` builds on them, the `expect.extend` adapter, and skipping a test live mode can't run, with the reason (`setup.ts`); a channel's fixture refused live becomes a stand-in that refuses on first use, so only that channel's tests skip (`refused.ts`, `refusedLive` for channelstack's own per-test checks) |
| Jest | `integrations/jest/` *(planned, phase 7)* | Globals, the `expect.extend` adapter |
| Checks | `integrations/checks/` | `slackChecks()`, `githubChecks()`, `linearChecks()`, `notionChecks()`: the standard behaviour checks, registered as ordinary tests, built on the public API and the matchers only. `SLACK_CHECKS`, `GITHUB_CHECKS`, `LINEAR_CHECKS` and `NOTION_CHECKS` list their ids |
| pytest | `integrations/pytest-channelstack/` *(planned, phase 7)* | Fixtures and assertion helpers |

## Generated code (never edit by hand)

| Path | Generated from |
|---|---|
| `spec/openapi.json`, `spec/ir.json` | The routes (`pnpm spec`) |
| `sdks/typescript/generated/`, `sdks/python/channelstack/generated/` | `spec/ir.json` (`pnpm sdk`) |
| `server/src/drivers/linear/schema/schema.ts` | `server/src/drivers/linear/schema/schema.graphql`, Linear's schema at a pinned commit (`pnpm linear:schema`) |
