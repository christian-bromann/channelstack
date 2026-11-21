# Do agent *app* developers need channelstack?

Research date: 2026-11-19. Method:
- GitHub code search over dependents of agent and chat SDKs.
- File trees and tests of 28 sampled repos.
- Issue searches on about 25 significant apps.

All read-only.

## How many apps there are

There are about 5,000–10,000 open-source agent apps that live in a channel. About 300–500 have 100+ stars, and most of those were pushed in 2026. Raw code-search hits:

| Dependency combination | Hits |
|---|---|
| Telegram + an LLM | ~7.5k |
| Discord + an LLM | ~6.8k |
| Slack Bolt + an LLM | ~2.9k |
| Chat SDK adapters | ~800 |
| Teams (`@microsoft/teams.apps`, `botbuilder` + an LLM) | ~620 |
| Linear `agentSession` | ~360 |
| Probot / `@octokit/app` + an LLM | ~180 |

## How they test (sample of 28)

| Approach | Share | Examples |
|---|---|---|
| SDK mocks only | 71% | nao, OWASP Nest, openai-security-bots, cyrus, Roomote, ChatGPT-CodeReview |
| No channel tests | 14% | llmcord and most Discord bots |
| Fake server or emulator | 11% | getsentry/junior (msw), paradigmxyz/centaur (emulate plus a fake-slack e2e service), one Telegram bot |
| Live platform | 4% | openclaw |

Among the larger apps, every team that cares has built a two-tier setup of its own:
- **n8n:** recorded-session replays, plus contract tests that forge Teams tokens.
- **Open SWE:** a fake Slack in Playwright, plus a GitHub delivery replayer.
- **ElizaOS:** "connector certification" scenarios.
- **kodus:** mock HTTP servers, plus a live matrix across 5 git hosts.
- **pr-agent and claude-code-action:** fixture-plus-mock unit tests, plus live runs on real repos that only start by manual dispatch or by dogfooding.
- **pullfrog:** a fixture refresher and a Docker image that mocks GitHub Actions.
- **sweep:** pickled real webhooks.

## The same bugs everywhere

These bugs come from how the platform behaves, which mocks don't model.

**Chat apps** (OpenClaw, Chatwoot, Mastra, OpenHands, ElizaOS, Onyx, AnythingLLM, n8n, Dify, AstrBot):
1. **Duplicate replies.** Caused by Slack's 3-second retry, SDK retry policies, per-process dedupe caches, or edits treated as new messages. Examples: openclaw#1481, chatwoot#15450, mastra#18877, OpenHands#13358, eliza#37505.
2. **Threading.** Replies leave the thread, post in both thread and channel, or the thread ID overflows. Examples: openclaw#1163, n8n#43054, onyx#15347.
3. **Messages dropped without an error, and timeouts.** Examples: onyx#13588, chatwoot#16110, openclaw#201012.
4. **Formatting and length.** mrkdwn and MarkdownV2 escaping, code fences, chunk splitting. Examples: anything-llm#6546, eliza#34294 and #22217.
5. **Streaming finalization.** A stream is finalized twice, or a 429 retry storm hits. Examples: openclaw#158103 (Teams answered twice), vercel/chat#1036.
6. **Button and interactivity.** Duplicate clicks, or clicks lost across restarts. Examples: mastra#30443, openclaw#152607.
7. **Auth, scopes and connection lifecycle.** Examples: chatwoot#4282, vercel/chat#953, openclaw#128809, dify#41752 ("works in Test Run, not once Published").

**GitHub and Linear apps** (pr-agent, claude-code-action, OpenHands, kodus, pullfrog, run-gemini-cli, sweep):
1. **Duplicate or re-posted comments.** Examples: pr-agent#3051 and #3157, cca#1781, kodus#1699.
2. **Self-trigger and bot-identity loops.** Examples: cca#794 and #1299, kodus#1946, pr-agent#1528 (an infinite loop) and #4326.
3. **Missed triggers.** Review-thread replies and @mentions don't fire. Examples: OpenHands#12513, gemini#172, kodus#1838.
4. **Token and permission errors.** Examples: cca#1683, pullfrog#112, OpenHands#18939.
5. **Check runs stuck or falsely green.** Examples: cca#1361 and #1679, pr-agent#3931.
6. **Comments on the wrong line.** Examples: kodus#2015, pr-agent#2641.

**Linear:** the official demos (linear/weather-bot, claude-managed-agents-demo) have no tests. Their README says to install the app and @mention the agent in a real workspace.

Explicit requests are rare but present:
- pr-agent#1237 asks for a dry-run mode.
- cca#503 asks "how to test this tool".
- OpenHands#10621 asks for a local agent.
- eliza#2403 asks for tests for the Slack client.
- n8n#14102 and n8n#34204 report test webhooks that work while production fails.

The demand mostly shows up as bug volume and as home-built tooling, not as requests.

## What this means for channelstack

The app developers' main constraint is that **71% only mock and 14% have nothing; they don't write e2e tests.** A test-writing API alone won't reach them. Channelstack needs a mode that gives value without writing any tests.

### 1. Zero-test mode: `channelstack check`, like Lighthouse for channel agents

```bash
npx channelstack check --slack --agent "pnpm start"
```

channelstack boots the fakes, starts the agent pointed at them, and runs the **standard contract suite**. It then prints a report:

```
Slack  ✔ replies once to a DM
       ✖ replies twice when Slack retries after 3s          (seen in: openclaw#1481, chatwoot#15450)
       ✔ replies inside the thread
       ✖ reply over 40k chars → msg_too_long, no fallback   (pi#1753)
       ✔ ignores its own messages
       ✖ stream never stopped after Stop
GitHub ✖ responds to its own comment (loop)                (cca#794, kodus#1946)
       ✔ review-thread reply triggers
```

Each scenario is one of the recurring bugs listed above. The agent's model is replaced by a fake that speaks the OpenAI/Anthropic wire format, so runs are deterministic and cost nothing. This is the hook for the long tail. It also suits a GitHub Action, as a "channel conformance" badge.

### 2. Write your own scenarios: actors and assertions

For teams like junior, centaur, n8n, kodus and open-swe that already built fakes:

```ts
await ana.mentions(bot, "review #42");
await expect(thread).toHaveRepliesFrom(bot, { count: 1 });
```

### 3. Same scenarios, real workspace (later)

OpenClaw's nightly live lanes show the approach works. This would be a hosted offering with credential pools.

### First users to approach

| Group | Who |
|---|---|
| Already on fakes (easiest switch) | getsentry/junior, paradigmxyz/centaur (already uses emulate), n8n, langchain-ai/open-swe |
| Have the bugs, mocks only | inbox-zero, Chatwoot, Mastra apps, cyrus, Roomote, Onyx |
| GitHub agents | pr-agent, claude-code-action, kodus, pullfrog |
| Linear | cyrus; Linear's own demos (a docs partnership: "test your agent with channelstack") |

### Platforms, by demand and by gap

Slack is where the agent apps and the money are, and its streaming is uncovered. GitHub has the most bug evidence and needs bot-identity, review-thread and check-run fidelity. Teams has no fake anywhere. Linear has no tooling at all. Telegram and Discord have the largest volume but are mostly hobby bots, so they come later.

*Data note:* one sampling pass classified hermes-agent as "mocked". Its unit tests mock the Slack modules, but its e2e tier uses stand-in servers (see framework-testing.md).
