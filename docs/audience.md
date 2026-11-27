# channelstack: target audience

> Draft, 2026-11-19. Based on the research in `app-developers.md`, `framework-testing.md` and `niche.md`.

## In one sentence

**People who build an AI agent that lives in someone else's chat or dev tool (Slack, GitHub, Linear and Notion; Teams isn't planned yet), and who can't currently tell whether it behaves correctly there without trying it by hand in a real workspace.**

The size of the audience:
- 5k–10k open-source agent apps in channels, with about 300–500 serious ones (100+ stars, active in 2026);
- plus an unknown, but larger, number of closed-source internal and SaaS agents.

The audience has three tiers. The first one decides whether channelstack matters to the industry.

## 1. Primary: the agent app developer

**Who:** an engineer on a team of 1–10 that ships *one* agent into a channel:
- a support bot in Slack;
- a PR reviewer as a GitHub App;
- a coding agent you delegate Linear issues to;
- an internal "ask the docs" bot.

They write TypeScript or Python on top of Bolt, Chat SDK, Mastra, LangGraph, the OpenAI or Anthropic SDKs, or a hosted platform like MDA.

**Open-source examples of this person's project:**

| Surface | Examples |
|---|---|
| Slack | inbox-zero, getsentry/junior, paradigmxyz/centaur, Onyx, Chatwoot, wandbot, openai-security-bots |
| GitHub | pr-agent, claude-code-action, kodus, pullfrog, ChatGPT-CodeReview |
| Linear | cyrus, Roomote, Open SWE |
| Notion | agents answering @mentions in page comments (not yet surveyed) |
| Teams (not planned yet) | LinkSense, opengeni |

**How they work today:**
- **Developing:** a personal dev workspace, the app installed by hand, ngrok or a tunnel, and then switching to Slack after every code change to `@`-mention the bot.
- **Testing:** 71% mock the SDK (`vi.mock('@slack/web-api')`, `MagicMock`, nock) and assert on calls; 14% have no channel tests; a few (junior, centaur) run msw or emulate.
- **Before a release:** try it by hand in the real workspace and hope.

**What hurts.** These are their real bugs, and mocks never catch them:
- **The bot answers twice.** Slack's 3-second retry, an SDK retry policy, or an edit treated as a new message causes it (openclaw#1481, chatwoot#15450, mastra#18877).
- **The reply lands outside the thread, or in both thread and channel** (openclaw#1163).
- **The bot replies to itself or loops** (claude-code-action#794, kodus#1946, pr-agent#1528).
- **Messages are dropped silently.** Examples: an image ignored, a message over 40k characters, a missing scope (onyx#13588, pi#1753).
- **Streams finalize twice or never stop,** and Stop does nothing (openclaw#158103).
- **"Works in test, not in prod" webhooks** (n8n#34204, dify#41752).
- **The feedback loop is slow and needs credentials,** so nobody runs channel tests in CI.

**What they want (jobs to be done):**
1. "Let me talk to my bot locally without a workspace, an app install or ngrok."
2. "Show me what my bot actually sent and what Slack sent it."
3. "Tell me whether my bot has the usual bugs, without me writing tests."
4. "Let me write a test for the bug I just fixed, so it stays fixed."
5. "Run all of that in CI with no secrets."

**What channelstack gives them, in that order:**

| Job | channelstack |
|---|---|
| 1, 2 | `npx channelstack`: Slack at `https://slack.localhost` (and `github.`, `linear.`, `notion.localhost`), a browser client at `https://channelstack.localhost` with an inspector, and the attach CLI (`channelstack slack say --as ana …`). One env var per channel in the agent. |
| 3 | `slackChecks({ app })` in their test runner, or the Checks panel in the UI: about 12 checks, each named after a real bug class. |
| 4 | Their own test framework: the `channelstack/vitest` plugin (or `pytest-channelstack`) injects `slack`, `github`, `linear` and `notion` fixtures and extends `expect` with `toHaveRepliesFrom`, `toHaveCommentsFrom` and similar. "Save as test" from the UI. |
| 5 | `npx channelstack start --no-portless --port 4500 &` in CI. Models stay with their framework's own fakes or a real model. |

**The adoption trigger:** usually the first embarrassing production bug (a duplicate reply in a customer channel), or the first time a new teammate has to set up the dev workspace and ngrok.

**What success looks like for them:** they delete their ngrok setup and their mocked Slack client, and a channel bug class never comes back.

**Where to find them:** the emulate and portless READMEs, Chat SDK and Bolt docs, Linear's agent developer docs, skills.sh, X and Bluesky posts showing "my bot answered twice — here's the test", and template repos.

## 2. Secondary: framework and platform maintainers

**Who:** the teams behind multi-channel frameworks and platforms: OpenClaw, Hermes Agent, Vercel Chat SDK, Mastra, Flue, ElizaOS, n8n, Dify, LangChain (MDA and Open SWE).

**What they do today:** they build their own harness, at great cost:
- OpenClaw: about 630 scenarios and nightly live lanes with leased credentials.
- Hermes: platform stand-ins and a contract suite.
- n8n: replay and Teams JWT forging.
- MDA: 17.9k lines, closed for being too big.

The smaller ones (Mastra, Flue, Pi) only mock, or have nothing.

**What hurts:**
- They maintain fakes that drift.
- Credential pools for live tests are a burden.
- Teams can't be tested at all (OpenClaw#199876). channelstack doesn't cover Teams yet either.
- Every new channel adapter means rebuilding the harness.
- PRs that add test infrastructure get rejected as too large, as happened with the MDA stack.

**What they want:**
- A contract suite they can run per adapter.
- Fakes they don't have to maintain.
- The same scenarios against fakes and real workspaces.
- Smaller PRs.

**What channelstack gives them:** the shared version of their in-house harness, plus a credible "tested with channelstack" line in their adapter docs. Every app built on their framework then inherits a test story.

**Why they matter despite being few (about 10):** they're distribution. If Chat SDK, Mastra or MDA recommend channelstack in their testing docs, thousands of tier-1 developers arrive with it. They're also the most demanding fidelity reviewers.

**How to approach them:** the MDA re-land comes first, as proof from a real project. Then go to Open SWE, junior and centaur, which already use fakes. Then offer OpenClaw and Hermes a migration path off their in-house harness.

## 3. Also served: coding agents

**Who:** Claude Code, Cursor, Codex and similar, editing a tier-1 developer's bot.

**What they need:** a way to *see* the bot work while changing it: post as a user, click, read the thread, redeliver, run the checks. Without that, a coding agent edits Slack handlers blind.

**What channelstack gives them:** `npx channelstack mcp`, a skill on skills.sh, and plain-HTTP control endpoints. This follows portless and emulate, which are both designed "for humans and agents". It's also a growth loop: an agent that can test a Slack bot will suggest the tool.

## Later

| Audience | Why later |
|---|---|
| **Enterprise platform and QA teams** building internal Slack or Teams agents | Many need Teams, SSO and on-prem CI images. Teams isn't planned yet, so serve the Slack-first ones now. |
| **Provider developer relations** (Linear, Slack) | Partners, not users. Linear's demo agents have no tests and say "try it in a real workspace", so an official "test your agent locally" guide is a natural fit. |
| **Telegram hobby-bot authors** | The largest by count, but they rarely test or pay attention to tooling. Serve them once the core works. (Discord's bot authors are served since phase 11, [decision 0026](decisions/0026-discord.md).) |

## Not the audience

- **Teams buying LLM-quality evals.** "Was the answer good?" belongs to LangSmith, Braintrust and Promptfoo. channelstack answers "did the agent behave correctly in the channel?" The two complement each other.
- **Frontier labs buying RL environments.** That's a different buyer (Deeptune, Halluminate).
- **People testing their app's outbound SaaS calls** (Stripe, a password-reset email) with no conversation involved. That's emulate or the twin vendors. An agent people email, which answers in the thread, is in scope: the Resend and Google channels ([decision 0021](decisions/0021-email-channels.md)).

## What to say to each

| Audience | One line |
|---|---|
| Agent app developer | "Chat with your Slack bot locally, with no workspace and no ngrok, and catch the double replies before your users do." |
| Framework maintainer | "Delete your in-house channel harness. Run one contract suite per adapter, against fakes and real workspaces." |
| Coding agent (via skill, MCP or `channelstack slack say`) | "Use channelstack to post as a user, read the thread and run the checks while you edit this bot." |

## Open questions

1. **TS-first or Python at the same time?** About half the examples are Python (Onyx, Hermes, pr-agent, Bolt Python). The control API is plain HTTP either way; the question is when `pytest-channelstack` ships.
2. **Hosted platforms:** do users of MDA or other hosted agent platforms count as tier 1 (they test through the platform) or tier 2 (the platform integrates channelstack)?
3. **Pricing, if any:** keep everything local free and open. The only plausible paid layer is hosted runs against real workspaces with credential pools, which is exactly the infrastructure OpenClaw built by hand.
