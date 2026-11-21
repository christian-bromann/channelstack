# Where channelstack fits next to emulate

Research date: 2026-11-19. Sources:
- vercel-labs/emulate: 70 issues and 349 PRs, read with `gh`, plus the v0.14.0 source.
- The closed MDA local-stack PR stack: langchain-ai/managed-deepagents-sdk #1040, #1046, #1047, #1048, #1069, #1116, #1117, #1120, #1122.

## 1. What people complain about in emulate

| Theme | Approximate issue count | State |
|---|---|---|
| Webhook signing and payload fidelity (wrong headers; missing Slack envelope fields; `app_mention`; retries; Linear headers) | 11 | Mostly fixed. Stripe Event bodies (#324) are still open. |
| Slack surface for bot builders (interactivity, uninstall, Slack Connect; `slack_sdk` GET #319; `parent_user_id` #320; attachment blocks #326) | 10, plus about 10 outside PRs | Half open. Outside PRs are left open. |
| Auth too lenient (accepts revoked or unknown tokens, wrong 401/403/404) | 12 | Mostly fixed by a maintainer rewrite. SAML is open. |
| GitHub API gaps (GraphQL, git over HTTP, Actions secrets) | 10 | GraphQL PRs #337 and #213 got no response. Git over HTTP (#174) was closed. |
| Linear (priorityLabel, Agent Sessions) | 3, plus 2 PRs | Resolved by maintainer reimplementations (#196 → #394). |
| New providers | 7, plus about 20 PRs | Almost none merged. The suggested route is "write a custom emulator". |
| Testing ergonomics: record/replay #62, MSW interception #288, snapshot/restore #60 and #282, request inspector #61 | Mostly PRs | All open and stalled for months. |

What this says about the project:
- **It's run by one person.** ctate (Chris Tate) wrote about half of all PRs and did 174 of the merges.
- **Outside contributions rarely land.** Of 143 outside PRs, 12 merged (8%), 11 more were reimplemented by the maintainer, and 62 are still open with a median age of 74 days. #399 asks whether outside PRs are accepted at all and has no answer. There's no CONTRIBUTING file.
- **There's no public discussion outside GitHub.** No HN thread, no critical blog post. Nobody has filed issues for Chat SDK, Socket Mode, assistant threads or streaming.

**Out of scope per the README:** Slack streaming, Socket Mode, slash commands, shortcuts, workflows, interaction types other than buttons and modals; Linear dismissal, archiving, guidance and per-app session routing. **Stalled with no maintainer response:** record/replay, interception, snapshots for built-in services.

## 2. Why the MDA stack was 17.9k lines

The stack adds 17,868 lines, measured against the merge-base and excluding merged-in main. The table sorts every added line by what could remove it.

| Bucket | Lines | What it is |
|---|---|---|
| a. Already covered by emulate v0.14 | 1,955 | Mostly the custom fake Linear. #394 now covers Agent Sessions, `agentActivityCreate` and OAuth `client_credentials`. |
| b. Small upstream emulate PRs | 1,951 | See the list below. |
| **c. A generic test layer** | **5,633** | Supervisor, TLS CA, fake registry, people actors, delivery and redelivery helpers, thread waiters, scripted model, fixture staging. |
| d. MDA-specific | 8,329 | Includes about 3.0k of the #1040 CI restructure, 2.8k of e2e tests, URL overrides with tests (0.9k), Agent Auth patches (0.3k). |

The small upstream PRs in bucket b, at about 2.2–2.4k lines in total:
- Slack: event subscriptions from config; `chat.*Stream`; agent sessions and Stop; `apps.manifest.*` and `managedInstall`.
- GitHub App: `hook/config`, installation requests, `/installation/repositories`, a delivery log with redelivery.
- Linear: per-app webhooks, `Comment.url` and `Comment.agentSession`, redelivery.

**The generic layer is the biggest single bucket.** It's bigger than what emulate already covers and bigger than everything worth upstreaming, combined.

Setting #1040 aside (CI work unrelated to the fakes), the channel e2e work would land in MDA at about **4.5–5.5k lines** if a layer existed. It's 13.8k today.

That corrects my earlier bar: under 2k on the MDA side isn't realistic, because the e2e tests and URL overrides stay. A realistic target is under about 5k.

## 3. The niche

emulate fakes APIs. It doesn't test agents. Channelstack covers the parts emulate doesn't own, has declared out of scope, or has let stall:

1. **People actors and transcript assertions.** These already exist in the closed stack:
   - actors: `sendFakeSlackMessage`, `clickFakeSlack`, `stopFakeSlackSession`, `commentOnFakeGitHub`, `promptOnFakeLinear`
   - waiters: `waitForFakeSlackCall`, `runsOn`, `finishedRuns`
   
   They'd become typed and service-neutral: `slack.user("ana").says(...)`, `expect(thread).toHaveRepliesFrom(..., { count: 1 })`.
2. **Agent-surface overlays.** emulate's plugin API can't extend a built-in service, and outside PRs rarely land. So channelstack sits in front of emulate as a proxy that serves the missing agent routes itself and forwards everything else:
   - Slack: streams, agent sessions and Stop, Socket Mode, manifests
   - Linear: per-app webhooks, dismissal
   - GitHub: delivery log and redelivery
   
   Each route moves upstream if ctate ever ships it.
3. **The stack runner.** Boot the fakes, mint a local CA, and wire base URLs and CA env vars into any process: Node, Python, Go. This is today's `supervisor.ts`, `tls.ts` and `client.ts`. Python bots are under-served (#319).
4. **Testing primitives emulate has let stall:**
   - snapshot/restore per test
   - a request and delivery log
   - forged and replayed deliveries for idempotency tests (retries, redelivery)
5. **A scripted model.** `DirectiveChatModel`, which plays scripted `TOOL name args` lines, makes agent runs deterministic without an LLM. Nothing in emulate, and none of the eval tools, combines this with channel fakes.
6. **Later: a conformance suite** that checks the fakes against real providers. It's the reason to trust channelstack, not the pitch.

**Pitch:** "emulate gives you a fake Slack. channelstack gives you a fake *user* in it, and tells you whether your agent answered once, streamed, stopped when asked and survived a retry."

## 4. Risks

- **ctate builds the layer himself.** He reimplements good outside ideas, as with #196 → #394. Mitigation: stay agent-focused and language-neutral (proxy plus Python), which emulate's TS-first design doesn't prioritise.
- **The overlay drifts from emulate's state.** Streams posted through the overlay have to appear in emulate's `conversations.replies`. That needs a small, stable hook, or writing through emulate's own API.
- **Bucket d stays large.** Channelstack doesn't make the MDA e2e tests themselves disappear. The pitch should be "half the code and reusable", not "18k → 1k".

## 5. First step

Extract bucket c (about 5.6k lines that already work) from the closed stack into channelstack. Re-land the MDA channel tests on top of it and emulate v0.14, and measure the result against the 5k target. Upstream items 1–2 of bucket b (Slack event subscriptions from config, streams) as PRs, but don't depend on them landing.
