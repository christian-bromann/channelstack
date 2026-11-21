# Track 4: vercel-labs/emulate threat + demand signals

Research date: 2026-11-19. All numbers pulled live on that date unless marked (unverified).

## A. vercel-labs/emulate

### Vital signs
- Repo: https://github.com/vercel-labs/emulate, created 2026-03-20, 1,997 stars, 147 forks, 95 open issues+PRs, pushed 2026-11-20. Homepage https://emulate.dev ("Stateful, production-fidelity replacements ... No API keys. No network. Not mocks.").
- Releases: 18 tagged, v0.4.0 (2026-04-02) through v0.14.0 (2026-11-18). Since Aug: a release every 7-12 days (0.10 Aug 19, 0.11 Sep 2, 0.12 Sep 24, 0.13 Oct 29, 0.13.1 Nov 8, 0.14 Nov 18).
- Services (packages/@emulators): ai, apple, aws, clerk, core, github, google, linear, microsoft, mongoatlas, okta, resend, slack, stripe, twilio, vercel, plus adapter-next, adapter-nuxt.
- npm weekly downloads (2026-11-12..18, https://api.npmjs.org/downloads/point/last-week/<pkg>):
  - emulate 1,073,688; @emulators/core 299,172; @emulators/google 70,150; @emulators/adapter-next 56,111; @emulators/slack 43,229; @emulators/github 17,779; @emulators/stripe 6,886; @emulators/linear 2,726; @emulators/ai 455.
  - emulate monthly: Jun 190k, Jul 344k, Aug 679k, Sep 1.27M, Oct 1.62M, Nov 1-18 1.81M (roughly doubling every ~6 weeks until Oct, now flattening). Caveat: CI installs inflate counts; the eve repo pins it as a devDependency.
- HN launch: "Emulate by Vercel" 2 pts, 2026-04-02 (https://news.ycombinator.com/item?id=47618089). Growth is not HN-driven; it is driven by Vercel-internal adoption and skills/agent catalogs.

### Maintainers
- ctate (Chris Tate, Vercel) 166 commits, effectively the sole lead. lahfir (Vercel, "AI | Computer Use") 13, Railly (Railly Hugo, Vercel) 11. Everyone else 1-4 commits. Bus factor ~1, but Vercel-staffed.
- Notable external requesters: marcusschiesser (ex-LlamaIndex; filed a batch of 6 Slack fidelity issues on 2026-10-06, all fixed within 8 days), K-Mistele (Kyle Mistele, CTO HumanLayer; filed Slack signature/envelope/app_mention issues 2026-09-15, all fixed), jychp (SubImage), devin-ai-integration bot.

### Where it already overlaps channelstack (important: more than expected)
Slack (https://github.com/vercel-labs/emulate/blob/main/packages/%40emulators/slack/README.md):
- Signed Events API callbacks (X-Slack-Signature v0) with full envelopes (#266, #267, #310), app_mention emission (#307), event retries with X-Slack-Retry-Num via `POST /_slack/simulate/event-retry` (#313), app uninstall/tokens_revoked (#311), Slack Connect users (#314), channel privacy (#315).
- Interactivity: signed block_actions and view_submission via `POST /_slack/simulate/block-actions` and `/_slack/simulate/view-submission`, with acting user, trigger_id, response_url (#312, merged 2026-10-14).
- Actor simulation exists in a basic form: seed user tokens, post as a user, the bot gets a signed event. That is channelstack's "scripted human actor" primitive, minus a scripting DSL.
- Strict mode: `strict_scopes`, unknown-token rejection (#391), 40k-char limit with Slack's warning (#244).
- Inspector UI with Events tab and event deliveries.
- Explicitly NOT implemented (README): Socket Mode, slash commands, shortcuts, chat streaming (chat.startStream/appendStream/stopStream), assistant threads, canvases, lists, workflows/functions, user groups, exact rate limits.
- Open: #416 (2026-11-17) event_subscriptions in seed config, i.e. inbound events are becoming first-class config.

Linear: GraphQL subset plus Agent Interaction API: AgentActivityCreateInput, AgentActivityContent union, session status/plan/externalUrl, `AgentSessionEvent` created/prompted webhooks signed with Linear-Signature, tested through @linear/sdk (#394, merged 2026-11-13, shipped in v0.14). So emulate now targets Linear agents specifically.

GitHub: repo/org webhooks with deliveries, GitHub App installations and installation tokens with permission enforcement, X-Hub-Signature-256 signing. Open #413 (GUID delivery IDs), #337 (GraphQL PRs), #277 (fuller push payloads, commit statuses).

AI: v0.14 added @emulators/ai: deterministic OpenAI Chat Completions/Responses and Anthropic Messages endpoints with SSE streaming (#339-#345). Low adoption so far (455/wk).

Interception: emulate is base-URL-swap by default. Open PR #288 (jacobparis, 2026-10-05) adds `@emulators/adapter-msw` for zero-config in-process interception with production URLs, including routing webhook deliveries into in-process handlers. Not merged after 6 weeks. No HTTPS MITM proxy anywhere.

Recording: open PR #62 (mvanhorn, 2026-04-08) `emulate record` proxy that generates seed configs. Stalled 7 months.

Spec validation: none. No OpenAPI/AsyncAPI conformance checks; fidelity is maintained by hand (issue-driven, "match the real API" PRs) and contract tests using official SDKs. Searches for "openapi" return only unrelated Okta PRs.

### Ties to Vercel's agent stack (confirmed in code, not marketing)
- vercel/chat (Chat SDK) uses emulate for its own integration tests: "Emulator tests ... Drive the SDK against an in-process Emulate.dev server" for Slack and GitHub (https://github.com/vercel/chat/blob/main/packages/integration-tests/README.md; PRs #477, #479 merged 2026-05-10; #591 2026-06-06 expanded to emulate 0.6.0). Notably, the Chat SDK test harness re-signs Slack event_callbacks itself via an in-test forwarder.
- vercel/eve pins `emulate` 0.13.1 as a devDependency, used today only for a Microsoft OAuth emulator in a TUI test (packages/eve/test/tui-client/tui-connection-auth-user.ts).
- emulate.dev sits in Vercel's site nav next to eve, Chat SDK and "Agent Stack", but emulate's own copy does not mention agents, chat bots or Chat SDK. No blog post, changelog entry or X statement tying emulate to eve/Chat SDK testing was found (web search; X not directly searchable, unverified).

### Direction verdict
- Inbound events: YES, already shipped for Slack, GitHub, Linear (signed, retries, interactivity). Trend accelerating (Slack batch Oct, Linear agents Nov, event_subscriptions seed config open).
- Actor simulation: PARTIAL. Users can act via seeded tokens and `/_slack/simulate/*` endpoints; no scenario/script layer, no multi-actor timeline, no assertions on rendered conversation.
- Spec validation: NO signal. Fidelity is issue-driven and SDK-contract-tested.
- Interception: PROBABLE. MSW adapter PR open; no proxy/MITM. A transparent HTTPS proxy remains a differentiator, but MSW covers the Node in-process case.
- Agent-specific Slack surfaces (streaming, assistant threads, Socket Mode, slash commands): explicitly out today. Yet these are exactly where Chat SDK users hit bugs: vercel/chat #1036 (stream "Something went wrong" after Slack expires a segment), #983 and #1133 (native stream rotation). Highest-risk move for channelstack: emulate adds chat streaming because Chat SDK needs it.
- Pace: one Vercel engineer can close a 6-issue fidelity batch in a week. Assume any single-provider gap channelstack exploits can be closed within one release cycle if a Vercel team asks.

## B. Demand signals

### Counts (GitHub issues, title contains "test", user-facing ones filtered by hand)
- slackapi/bolt-js: 19 test-titled issues; 9 are "how do I test my app" questions (2020-2022). Keyword "mock" 18, "local development" 22.
- slackapi/bolt-python: 22 test-titled; ~9 user questions. #380 "Document about the ways to write unit tests" has 22 comments and is still OPEN since 2021-06.
- slackapi/node-slack-sdk: 23 test-titled; #1031 "Test kit (mainly for e2e tests)" and #770/#784 asking to disable signature checks for tests.
- slackapi/python-slack-sdk: 12 test-titled; #1188 (8 comments).
- probot/probot: 42 test-titled (mostly nock breakage); keyword "mock" 37.
- vercel/chat: ~0 user requests for testing tools (they ship emulate tests internally); vercel/eve: none found.
- Stack Overflow (api.stackexchange.com, total hits): "slack bot test" 192, "slack mock" 45, "github app webhook test" 43, "probot test" 15, "slack bolt test" 13, "linear webhook" 3. Top dedicated question "Testing Slack bots built with Bolt SDK" has 0 answers, 310 views.
- Hacker News (Algolia, typo-tolerance off): "fake slack" 13 stories incl. "Fake Slack that helps you test bots without using real slack servers" 37 pts 2019 (https://news.ycombinator.com/item?id=20342418); 5 "Slack emulator" Show HNs 2018-2019 (for demos). 2026 agent-testing launches are frequent but generic (Attest 2026-11-15, Mirrors 2026-07-02, Trajectly 2026-03-05), none channel-specific.
- DIY signal: GitHub repos named mock/fake slack: ~51 "slack-mock" + 35 "fake slack" + 35 "slack emulator" matches. 2026 agent repos write their own: kucukkanat/hopstr #143 (2026-11-16) P0 story for a `mock-slack-api` covering "Socket Mode ... streams, agent sessions"; Felag-Engineering/gleipnir #237 (2026-05-03) Slack-trigger-to-reply e2e validated via Playwright on real Slack; earchibald/home-brain #5 (2026-02-15) e2e by DMing a live bot from CI; bamseynet/swe-ticket-orchestrator #133 (2026-10-31) "Conformance on the fake ... live-tagged suite".
- Overall read: demand is chronic and long-tail (questions since 2016, rarely high-vote), mostly unanswered by vendors; Slack never shipped a test kit (node-slack-sdk #1031 closed). The 2026 wave of channel agents is producing DIY fakes rather than loud asks. That is a "pain people solve badly in-house" profile, not a "people beg on forums" profile.

### Representative quotes (all <15 words)
1. "there doesn't seem to be a way to send our app test events" - bolt-python #681, 2022-07-14, https://github.com/slackapi/bolt-python/issues/681
2. "I need to make the request signed with the secret, otherwise bolt throws" - bolt-js #1336, 2022-02-25, https://github.com/slackapi/bolt-js/issues/1336
3. "given the lack of test kits, I have to understand how Slack signs" - node-slack-sdk #1031, https://github.com/slackapi/node-slack-sdk/issues/1031
4. "override the WebSocket URL to point the application to a Mock Slack" - bolt-js #803, 2021-02-18, https://github.com/slackapi/bolt-js/issues/803
5. "I am looking to write unit tests for my Bolt API" - bolt-python #380 (22 comments, open), 2021-06-15, https://github.com/slackapi/bolt-python/issues/380
6. "send a slash command event to the application and then confirming the correct response" - SO 69455581, 2021-10-05, 0 answers, https://stackoverflow.com/questions/69455581
7. "end-to-end testing of probot apps using the real GitHub API and smee.io" - probot #947, 2019-06-18, https://github.com/probot/probot/issues/947
8. "Testing Using Nock does not work" - probot #1977, 2024-02-19, https://github.com/probot/probot/issues/1977
9. "no way to verify the live Brain Assistant bot actually works end-to-end" - home-brain #5, 2026-02-15, https://github.com/earchibald/home-brain/issues/5
10. "mock-slack-api covers Socket Mode, ... streams, agent sessions" - hopstr #143, 2026-11-16, https://github.com/kucukkanat/hopstr/issues/143
11. "Slack shows a stream it closed itself as a 'Something went wrong' pill" - vercel/chat #1036, 2026-10-13, https://github.com/vercel/chat/issues/1036
12. "chat.postMessage and the other writes dispatch to nobody" - emulate #416, 2026-11-17, https://github.com/vercel-labs/emulate/pull/416

### How many teams build channel agents (proxies)
- npm weekly (2026-11-12..18): `chat` (Chat SDK) 7.89M, @chat-adapter/slack 3.53M, @chat-adapter/github 257k, @chat-adapter/linear 190k; `eve` 2.20M; @slack/bolt 5.14M; @slack/web-api 21.5M; @linear/sdk 4.62M; probot 103k. Download counts overstate teams (CI, transitive installs); treat as relative scale only.
- GitHub stars: vercel/chat 2,483 (created 2025-12-22); vercel/eve 6,018 (created 2026-06-16).
- Slack Marketplace: "more than 2,600 apps and integrations" (Slack platform newsletter June 2026, https://slack.dev/newsletter/platform-newsletter-june-2026/); Salesforce AgentExchange merge cites 2,600+ Slack apps and agents and 1,000+ Agentforce agents (https://www.salesforceben.com/appexchange-slack-marketplace-and-the-agentforce-ecosystem-are-now-one-with-fresh-50m-funding/). No agent-only Slack count published (unverified split). "Add to Slack" agent provisioning launched Aug 2026 (https://app.slack.com/blog/news/add-to-slack).
- Linear agents directory: 41 agents listed on https://linear.app/integrations/agents (counted 2026-11-19: Codex, Cursor, GitHub Copilot, Factory, Devin, Sentry, Warp, ...).
- 2026 OSS channel-agent projects with large followings: nanocoai/nanoclaw 31k stars, chenhg5/cc-connect 16k, CopilotKit/OpenDots 6.7k, sandbox-quantum/switch 4.7k (GitHub search, created after 2025-06).
- Estimate (unverified, reasoning): low thousands of teams ship public channel agents (2.6k Slack listings, 41 Linear agents, GitHub Marketplace apps), plus an order of magnitude more internal Slack/GitHub bots. Chat SDK + eve downloads suggest tens of thousands of projects experimenting.

## Reddit
NOT COLLECTED. The Arctic Shift API requires subreddit or author with `query`/`title`, and on 2026-11-19 every subreddit-scoped full-text search (r/Slack, r/SlackDev, r/AI_Agents, r/LangChain, r/node, r/Python, r/ExperiencedDevs) returned "Timeout. Maybe slow down a bit" or "Too many requests", even when spaced out. Re-run later, e.g. `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=Slack&title=test&after=2024-01-01&limit=100`.
