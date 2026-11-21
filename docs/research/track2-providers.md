# Track 2: Provider-specific and bot-framework testing tools

Researched 2026-11-19. Stars and dates come from `gh api repos/...`. Weekly downloads come from api.npmjs.org (last-week point). Treat npm numbers as rough: CI mirrors and transitive installs inflate them. Anything not checked against a primary source is marked (unverified).

Legend for the four channelstack capabilities:
- **SF** = stateful provider fake
- **SIG** = signed inbound events (webhooks/events the app receives)
- **ACT** = actor simulation (a scripted human clicks, comments, stops, installs)
- **CONV** = assertions on the rendered conversation a human would see

## Headline finding: Vercel Labs "emulate" is the closest competitor

**vercel-labs/emulate** (https://github.com/vercel-labs/emulate, https://emulate.dev)
- Apache-2.0, created 2026-03-20, 1,997 stars, v0.14.0 released 2026-11-18. Releases ship roughly every 1-2 weeks (v0.13.0 10-29, v0.13.1 11-08, v0.14.0 11-18).
- npm weekly downloads: `emulate` 1.07M (looks inflated, unverified), `@emulators/slack` 43k, `@emulators/github` 17.8k, `@emulators/linear` 2.7k.
- Pitch: "Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation. Not mocks." Each service runs on its own localhost port: Vercel, GitHub, Google, Slack, Apple, Microsoft, Okta, AWS, Resend, Stripe, MongoDB Atlas, Clerk, Linear, Twilio, plus an "AI" service with deterministic OpenAI/Anthropic replies. It also has a custom-emulator SDK (`defineEmulator`), seeds, snapshot/restore/reset, an inspector web UI, and Next/Nuxt adapters.
- **Slack** (https://emulate.dev/docs/slack):
  - SF: chat.*, conversations.*, users, reactions, files v2, pins, bookmarks, views (trigger_id with a 3s TTL), OAuth v2, apps.uninstall, incoming webhooks.
  - SIG: `event_callback` deliveries signed with `X-Slack-Signature` when a signing secret is configured, plus `/_slack/simulate/event-retry`, which redelivers with `X-Slack-Retry-Num`.
  - ACT: `/_slack/simulate/block-actions` and `/_slack/simulate/view-submission`. No shortcut, slash-command or `view_closed` simulation.
  - Not implemented: **chat.startStream/appendStream/stopStream**, which its own coverage file lists as "Future work" (packages/@emulators/slack/src/__tests__/slack-coverage.ts). **assistant.threads.setStatus** is also absent (no search hits).
- **GitHub**: SF over repos, issues, pulls, reviews, comments, checks, actions, apps, installation tokens. SIG: its webhook dispatcher signs `X-Hub-Signature-256`.
- **Linear**: SF through a GraphQL emulator that includes **Agent Sessions and Agent Activities** (thought, elicitation, action, response, error, prompt, and the signals auth/continue/select/stop), validated against Linear's GraphQL schema. Outbound webhooks are supported.
- **Microsoft** is an identity (Entra) emulator, not Teams Bot Framework (unverified beyond the service list).
- CONV: an inspector UI lists conversations, messages and deliveries. It has no "what the human sees" renderer and no conversation-level assertion DSL.
- Interception: you point the SDK's `apiUrl`/base URL at localhost. It is not a transparent HTTPS proxy.
- **Adoption signal:** Vercel's own Chat SDK integration tests use it (below), and roughly 10 other repos import `@emulators/slack` (GitHub code search).
- **Implication for channelstack:** emulate already covers SF, SIG and part of ACT for Slack, GitHub and Linear. Channelstack's room to differentiate:
  - Slack AI surfaces: streaming, assistant threads/status, `agent_session_stopped`.
  - Transparent HTTPS interception (no code changes needed for base URLs).
  - Spec-fidelity conformance.
  - First-class actors/scenarios (Stop, install flows).
  - Assertions on the rendered conversation.
  - Teams/Discord.

## Slack

| Tool | Covers | Last activity | Adoption | SF | SIG | ACT | CONV |
|---|---|---|---|---|---|---|---|
| Bolt (js/python/java) testing story | No official test helpers. A Bolt-Python maintainer said they knew of no built-in helpers (https://github.com/slackapi/bolt-python/issues/380). Community packages: `@slack-wrench/jest-bolt-receiver` (2022, 7 dl/wk), `@slack-wrench/fixtures` (249/wk), `botlint-slack` 0.1.3 (2026-04, 1.5k/wk: Block Kit validation + mock client) | bolt-js pushed 2026-11-19, @slack/bolt 5.1.0 | bolt-js 2,954 stars, @slack/bolt 5.1M/wk | No | No | No | No |
| slack-mock (Skellington-Closet) | Mock Web API, RTM, slash commands, interactive buttons, outgoing webhooks via nock | 2021-03 code, npm 1.1.1 2022-06 | 66 stars, 175/wk | Partial (records calls, not state) | Unsigned | Partial (send slash/button payloads) | No |
| slackapi/steno | Official record/replay of HTTP in both directions | **Archived**, last push 2021-08 | 186 stars | No (replay) | Replays recorded | No | No |
| mad-fake-slack (maddevsio) | Fake Slack UI + API for Puppeteer e2e of bots | 2023-01 | 42 stars | Yes (small) | ? | Via UI | UI-level (unverified) |
| Slack developer sandboxes | Free Enterprise Grid sandbox through the Developer Program (launched 2025-02-05). Lifespan about 6 months, extendable, up to 2 active (sources conflict). Slack's AI-apps docs point to it for paid-plan AI features | live | n/a | Real Slack | Real | Manual/real users only | Real UI |
| Slack CLI (`slack run`, `slack trigger`) | Local dev server for Deno/Bolt apps, socket mode, trigger creation for workflow apps. `@slack/cli-test` (5.0.0, 58/wk) wraps the CLI for automated tests of the CLI itself | v4.14.0 2026-11-13 | 322 stars | No | Real Slack | No | No |
| Slack engineering on testing | Slack Engineering ran 200+ agentic E2E runs (Playwright MCP/CLI, Claude) on *Slack's own UI*. That is not bot testing (summary via daily.dev, unverified) | 2026 | | | | | |
| Slack-sanctioned AI-app testing | https://docs.slack.dev/ai/developing-ai-apps has no testing section. It points to sandboxes, Block Kit Builder and Bolt. No official fake exists for chat.startStream / assistant.threads.setStatus. The only mock found is a community Elixir SDK (Slink.Testing captures stream calls) | | | | | | |

## Microsoft (key precedent)

- **Bot Framework Emulator** (https://github.com/microsoft/BotFramework-Emulator): desktop app that chats with a local bot over the Direct Line protocol, with transcript and inspector. **Archived**, last release v4.15.1 on 2024-10-01, 1,894 stars. `botbuilder-testing` (TestAdapter/DialogTestClient) gets 819 dl/wk, and the botbuilder-js repo is archived.
- **Microsoft 365 Agents Playground** (formerly Teams App Test Tool; https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/debug-your-agents-playground):
  - The CLI `teamsapptester start` opens a local web app that "emulates the Teams or WebChat client and Bot Framework service". It needs no tenant, tunnel or app registration.
  - Channel IDs: msteams, directline, webchat, emulator.
  - Mock data in `.m365agentsplayground.yml` (tenant, bot, users, which must be exactly 5, team, channels) backs connector APIs such as `TeamsInfo.getPagedMembers`.
  - "Mock an Activity" offers install/uninstall, add/remove user, app, channel and team, renames, and a custom JSON activity (for example messageReaction).
  - It sends a JWT to the bot and validates the bot's reply, and it renders Adaptive Cards with the real Teams renderer.
  - Gaps: no typing indicator, message extensions, dialogs, SSO, mobile or meetings, and the manifest is ignored.
  - **No headless/CI scripting API is documented**: it is an interactive inner-loop tool.
  - Adoption: `@microsoft/m365agentsplayground` 73k/wk, `@microsoft/teams-app-test-tool` 15k/wk, 0.2.30 published 2026-11-04. The toolkit repo (OfficeDev/microsoft-365-agents-toolkit) has 791 stars and was active 2026-11-19. The old Teams SDK "DevTools" is deprecated in favor of the Playground (https://microsoft.github.io/teams-sdk/blog/devtools-to-agents-playground).
  - Scores: SF partial (mock roster), SIG yes (JWT), ACT yes but manual via UI, CONV visual only, no assertions. This is the strongest proof that a provider will ship a "simulated client". Channelstack would be the scriptable, multi-provider, CI-first version of it.

## Discord

There is no official harness, and community tooling is stale and tiny:
- corde (https://github.com/cordejs/corde): e2e that drives a real Discord bot account. 126 stars, last push 2023-05, 67 dl/wk.
- discord-mock-server (suneettipirneni): 10 stars, 2022.
- discordgo-mock: 22 stars, 2025-05.
- jest-discordjs-mocks: 4 stars.
- discord.js itself: 26.8k stars, 2.0M dl/wk.

No stateful gateway fake exists with real signed interactions (Ed25519) and actor simulation. This is a green field.

## GitHub

| Tool | Notes | Last | Adoption | SF | SIG | ACT | CONV |
|---|---|---|---|---|---|---|---|
| @octokit/fixtures | Records and replays REST scenarios through nock | v23.1.2 2026-04-07 (repo push 2026-11-16) | 109 stars, 1.3k/wk | No (replay) | n/a | No | No |
| @octokit/webhooks (schemas/examples/types) | **Deprecated**. The README says it is "woefully out of date and not maintained anymore" and points to octokit/openapi-webhooks (v12.2.0 2026-10-05, 7 stars). Still heavily downloaded: types 9.7M/wk, examples 125k/wk, schemas 45k/wk | 7.6.1 2026-08 | 259 stars | Payload source only | | | |
| Probot + nock | Docs pattern: `probot.receive({name, payload})` + nock for the outbound API. Unsigned in-process injection | v14.3.7 2026-11-03 | 9,642 stars, 103k/wk | No | No (bypasses) | No | No |
| smee.io / smee-client | Webhook relay proxy to localhost | client 5.0.0 2025-11 | 486 / 567 stars, 208k/wk | No | Forwards real | No | No |
| nektos/act | Runs Actions workflows locally in Docker. No webhook or API fake | v0.2.98 2026-11-16 | 72.7k stars | No | Event JSON file | No | No |
| gh webhook forward (cli/gh-webhook) | Forwards real repo/org webhooks to localhost | v0.2.0 2025-10-21 | 45 stars | No | Real (signed with --secret) | No | No |
| GitHub App e2e harness | None found besides emulate's GitHub emulator | | | | | | |

## Linear

- The official SDK (`@linear/sdk` 103.0.0, 4.6M/wk; linear/linear 1,681 stars) ships webhook-signature helpers but no mocks or test client (unverified for helpers).
- The Agents API is a "Developer Preview". It expects a reply within 10s of an `AgentSessionEvent` created event, and simply enabling the webhook makes the Agent Session UI appear in the workspace (https://linear.app/developers/agents). There is no documented test or sandbox story beyond a real workspace.
- Hookdeck publishes a guide on building Linear agents with its CLI as a relay.
- Only emulate's `@emulators/linear` fakes Agent Sessions.

## Agent frameworks: do any ship channel-level e2e harnesses?

- **Vercel Chat SDK** (https://github.com/vercel/chat):
  - 2,483 stars, 4.45.0 released 2026-11-13. npm `chat` reports 7.9M/wk and `@chat-adapter/slack` 3.5M/wk (both look inflated, unverified).
  - `@chat-adapter/tests` (117k/wk) provides Vitest factories: `createMockAdapter` (every method a `vi.fn()`), an in-memory `createMockState`, `createTestMessage`, and matchers `toHavePosted`, `toHaveEdited`, `toHaveReactedWith`, `toHaveStartedTyping` and `toHaveDispatched`. These are adapter-call assertions, not a provider fake.
  - The README claims "signed Slack webhook builders" live in each adapter's `/testing` subpath, but `@chat-adapter/slack` exports no `./testing` (unverified mismatch).
  - Internally, `packages/integration-tests` contains replay tests built on recorded production webhooks (including replay-streaming and replay-assistant-threads). It also contains **emulator tests against `@emulators/slack` and `@emulators/github`**, whose "assertions read the emulator's stateful store", and an in-test forwarder that re-signs Slack events.
  - This is the closest existing pattern to channelstack, but it is internal and not packaged.
- **eve** (https://github.com/vercel/eve; 6,018 stars, created 2026-06-16): testing means file-based `eve eval` with a mock model, run in deterministic world suites. Its channels go through the Chat SDK (`eve/channels/chat-sdk`, depends on @chat-adapter/slack). No channel-level fake or actor harness was found. `packages/eve/test/tui-client` covers its own TUI only.
- **Cloudflare Agents** (6,010 stars): Vitest with `@cloudflare/vitest-pool-workers` running in the Workers runtime (https://developers.cloudflare.com/agents/getting-started/testing-your-agent). No channel fakes.
- **Mastra** (29.7k stars), **OpenAI Agents SDK** (py 30.8k, js 4.0k stars) and **LangGraph** (45.2k stars): no channel-level e2e harness found (searched, not exhaustive).
- **Botium** (codeforequity-at/botium-core; 250 stars, push 2026-11-09, 3.3k dl/wk): legacy conversational-test DSL ("convos") with connectors. It is closest in spirit to CONV assertions, but it talks to bot endpoints and does not fake providers.

## Webhook tooling ("the provider calls you")

- **Stripe CLI** (https://github.com/stripe/stripe-cli; 2,241 stars, v1.55.14 2026-11-19), the gold standard:
  - `stripe listen --forward-to` relays real test-mode events, **signed** with a per-session `whsec_` secret.
  - `stripe trigger <event>` creates real API objects through fixtures, so the cascade of events is authentic.
  - It also covers `events resend` and log tailing. The state lives in Stripe test mode, not locally.
  - `stripe-mock` (1,663 stars) is the stateless OpenAPI-driven API fake. Its lesson: stateless mocks are not enough, which is why Stripe pairs it with test mode.
  - Scores: SIG yes, ACT yes ("trigger" equals actor), SF in the cloud.
- **Hookdeck CLI/Console** (hookdeck-cli 371 stars, v3.2.0 2026-11-16): relays to localhost and can inspect, filter, retry and replay events. It also ships an MCP server. It is a relay with no provider fakes and no event synthesis (unverified whether the Console can send sample provider payloads).
- **Svix Play** (https://www.svix.com/play/): a free webhook inbox for inspection and replay. svix-webhooks has 3,486 stars. It receives events and does not synthesize provider events.
- **ngrok traffic inspector**: inspects tunneled requests and lets you replay or modify-and-replay them. Replay keeps the original signature, so a modified replay breaks HMAC verification.
- **webhook.site** (6,807 stars, push 2026-09): a request bin with custom actions. Receive-only.
- None of these model provider state or render conversations. Stripe's `trigger` + `listen` UX (named, catalogued scenarios that produce authentic, signed event sequences) is the DX bar for channelstack's actor commands.

## Gap summary for channelstack

1. Nobody fakes Slack's AI surfaces: chat.startStream/appendStream/stopStream, assistant.threads.setStatus and `agent_session_stopped`. emulate lists streaming only as future work.
2. Nobody asserts on the *rendered* conversation. emulate has a state inspector, Chat SDK has call matchers, and Agents Playground renders but cannot be asserted against.
3. No scripted, CI-first simulated client exists across providers. Agents Playground is the precedent, but it is manual and Teams-only.
4. Discord is untouched.
5. Interception: everyone requires base-URL overrides. A transparent HTTPS proxy is a real differentiator, but it competes with emulate's simplicity.
6. Risk: emulate is moving fast (16 services, weekly releases, Vercel backing), and adding streaming would close gap 1. Possible positioning: build on or interoperate with emulate (it has a custom-emulator SDK) and focus on actors, conversation assertions and fidelity conformance.
