# Live mode: acting on the real platforms

> Build spec, 2026-11-20. Replaces the earlier relay design (`live-delivery.md`, removed). Written so a coding agent can implement it without this conversation.
>
> - Per-method detail: [reality-matrix.md](reality-matrix.md).
> - Where it fits in the server: [implementation-plan.md](implementation-plan.md), sections 5 and 8.5.

## 1. Scope

**Most usage is fake.** Live mode is a user feature with a narrow job: **act on the real platform and observe the result.** A simple API for automation:

```ts
const ana = await slack.createUser({ name: "Ana" });     // real person if CHANNELSTACK_SLACK_USER_ANA_TOKEN is set
await ana.say("@my-agent deploy web to staging", { channel });
await expect(msg.thread).toHaveReplyFrom("my-agent");    // reads the real thread back
```

**Out of scope: getting events to the agent.** The real platform delivers to the agent directly, the way it does in production. How the agent is reachable (a public URL, Slack Socket Mode, a deployed staging agent, MDA's Trigger Server) is the agent's concern. channelstack never relays, forwards, re-signs or synthesizes deliveries to an agent live.

What follows from that:
- **Delivery chaos is fake-only:** forced retries, bad signatures, stale timestamps, redelivery, ack timing.
- **The exception is GitHub.** Its delivery log is readable through the API, so tests can still read what GitHub delivered to the agent and how the agent answered. channelstack stays out of the path.
- **Fake mode is unchanged.** There, channelstack is the platform and delivers to the agent itself (implementation plan 6.3).

## 2. How each live action is done

Every live action is one of three mechanisms. Observing is a fourth.

| # | Mechanism | Used for | Needs |
|---|---|---|---|
| A1 | **API call as the app** | Posting as the bot, installing the App on a repo, GitHub redelivery, reads the app can do | App credentials |
| A2 | **API call as a person** | Everything people do through normal API surfaces: say, reply, DM, edit, delete, react, comment, review, inline comment, resolve review threads, label, assign, delegate, create issues and pages | One user token per sandbox person |
| A3 | **Browser actor** | UI-only actions: Slack click, select, modal submit, shortcut, slash command, Stop, opening the agent thread, switching context; GitHub requested actions; Linear Stop; Notion "Add connections" | Sign-in secrets per person (section 5) |
| O | **Observe** | Checking that the agent reacted | Section 3 |

**Is a bot token enough?** Only for A1. A bot token acts as the bot, never as a person. So with only a bot token, live mode can post as the bot and read, but every `ana.*` action needs Ana's token (or the browser).

## 3. Observing the result

| Way | What it sees | Needs |
|---|---|---|
| **Reads** (default) | Everything a person can see through the API: messages, replies, reactions, comments, reviews, check runs, issue state, agent sessions and activities, page content. Matchers poll until the timeout (10 s by default) | A person's token or the app's credentials |
| **GitHub delivery log** | Each webhook GitHub delivered to the agent's App: event, payload, the agent's status code and duration (`GET /app/hook/deliveries`, App JWT). Read-only | The App's credentials |
| **Proxy mode** (optional) | The agent's own outgoing calls: Slack status line, streams, ephemeral messages, `views.open`. The agent opts in by running with `channelstack env --proxy` (implementation plan 6.2) | Agent configured for the proxy |
| **Browser** | What a person sees in the UI, including things with no read API (status line, ephemeral messages) | Sign-in secrets |

Things no API returns (Slack status, suggested prompts, ephemeral messages, in-progress streams) need proxy mode or the browser live, and say so in the matrix.

## 4. Credentials

All from environment variables in CI. None is committed or logged, and the control API never returns them (implementation plan 5, 12).

| Channel | A1 app | A2 person (per sandbox person `ANA`) | A3 browser sign-in |
|---|---|---|---|
| Slack | `CHANNELSTACK_SLACK_APP_ID`, `CHANNELSTACK_SLACK_BOT_TOKEN` | `CHANNELSTACK_SLACK_USER_ANA_TOKEN` (`xoxp-`) | Test inbox access |
| GitHub | `CHANNELSTACK_GITHUB_APP_ID`, `CHANNELSTACK_GITHUB_PRIVATE_KEY` | `CHANNELSTACK_GITHUB_USER_ANA_TOKEN` (fine-grained PAT, machine account) | `CHANNELSTACK_GITHUB_USER_ANA_PASSKEY` |
| Linear | The app's OAuth token | `CHANNELSTACK_LINEAR_USER_ANA_TOKEN` (personal API key) | `CHANNELSTACK_LINEAR_USER_ANA_PASSKEY`, or inbox |
| Notion | `CHANNELSTACK_NOTION_TOKEN` | `CHANNELSTACK_NOTION_USER_ANA_TOKEN` (personal access token) | Test inbox access |

The agent's own signing secrets are never needed live: channelstack doesn't sign anything the agent receives. In fake mode, channelstack generates them (implementation plan 1.1, "Secrets").

**Safety:**
- Live mode only acts in workspaces, orgs, teams and pages listed in `CHANNELSTACK_LIVE_*` allowlists.
- Everything a test creates is tagged and recorded in the cleanup ledger, and deleted at the end of its session (`channelstack sweep` after a crash).
- channelstack never changes the agent app's configuration live (manifest, webhook URL).

## 5. Browser actor sign-in

Unattended, so it runs in CI:
- **GitHub and Linear:** a passkey through WebDriver's virtual authenticator, with the private key loaded from a CI secret.
- **Slack and Notion:** the emailed code from a test inbox.

The session is saved and reused, and the browser signs in again only when `channelstack doctor` finds it expired. Account passwords are never handled.

Full table and rules: [reality-matrix.md, "Signing in without people"](reality-matrix.md#signing-in-without-people).

## 6. Verifying the fakes (internal, not a user feature)

The nightly differential run (implementation plan 9) compares fake and real behaviour. It's channelstack's own CI, with channelstack's own sandbox apps, so its setup never reaches users.
- **API responses:** the same calls against the real API and the fake, responses compared.
- **Webhook payloads:** channelstack's own test apps receive what the platforms send after each action, and the shapes are compared with the fake's:

  | Platform | How the payloads are received |
  |---|---|
  | GitHub | Read from the App's delivery log |
  | Slack | Socket Mode on channelstack's test app |
  | Linear, Notion | One named tunnel owned by the maintainers |

- **UI-only payloads** (`block_actions`, Stop, modal submit) are produced by the browser actor and received the same way.

## 7. Work breakdown

Paths follow implementation plan section 13.

| # | Piece | Where | Done when |
|---|---|---|---|
| W1 | Live adapters for person actions (A2) per channel | `server/src/drivers/<channel>/live/actions.ts` | Each A2 row in the matrix works against a sandbox; created objects are in the ledger |
| W2 | Live reads behind the transcript model and matchers (O) | `server/src/drivers/<channel>/live/reads.ts` | Matchers pass against real threads, timelines, sessions and pages, with polling and timeouts |
| W3 | GitHub delivery-log reads | `server/src/drivers/github/live/deliveries.ts` | `delivery.attempts`, `toBeAccepted` and `toBeRejected` work live on GitHub from the log |
| W4 | `unsupported_in_live` for fake-only features | `server/src/core/reality/` | Delivery chaos on Slack, Linear and Notion live reports `unsupported_in_live` with a reason; the test framework skips that step |
| W5 | Browser actor with unattended sign-in | `server/src/core/browser/`, `server/src/drivers/<channel>/live/ui.ts` | The A3 rows work for Slack first (click, Stop), then the others; `channelstack doctor` checks saved sessions |
| W6 | Allowlists, tagging and ledger cleanup | `server/src/core/safety/`, `server/src/core/ledger/` | Acting outside an allowlist is refused; `channelstack sweep` removes leftovers |

Order: W6 → W1 → W2 → W4 → W3 → W5. The fake's delivery signing (phase 1) uses the delivery cases in phases.md (appendix) as its acceptance tests.

## 8. Validation

### 8.1 Delivery signing (fake mode)

Before writing this spec, probes drove each platform's official receiver with the deliveries the fakes would send; all 21 cases passed. The cases are now the acceptance tests for the fakes' delivery code: [phases.md, "Appendix: delivery cases"](phases.md#appendix-delivery-cases).

### 8.2 Live spike (needs the sandboxes)

| Id | What | Pass when |
|---|---|---|
| V1 | Slack A2: `ana.say` with a user token triggers the agent's real `app_mention`; the reply is read back | `toHaveReplyFrom` passes |
| V2 | GitHub delivery log lists a delivery within a few seconds and shows the agent's status code and duration | Fields present; delay under 5 s at p95 |
| V3 | Browser sign-in without people on all four platforms in GitHub Actions | Sessions saved; second run reuses them |
| V4 | Browser A3 on Slack: click and Stop reach the agent | Agent's response visible in the thread |
| V5 | The open items in the matrix's "Still to confirm" list | Each answered and recorded in the matrix |

**Not yet supported live:** GitHub `ana.rerun`, and Notion `ana.resolve` / `reopen` with `discussion.resolved()` (all work in the fake). Live runs report `unsupported_in_live`.

## 9. Open questions

None right now. New ones go here.
