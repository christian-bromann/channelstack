# Phase 2 plan

Goal: Slack interactivity and Socket Mode. Every fake Slack example passes.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 2.1 Every fake Slack example passes | `api/examples/slack.test.ts`, everything but "live mode", unchanged, against `examples/agents/bolt-ai-sdk` and `examples/agents/chat-sdk-slack` (`pnpm test:accept`; `scripts/examples.ts` enables the remaining blocks) | `server/src/drivers/slack/` (interactions, views, commands, Stop, the agent split view), `integrations/matchers-core/` (`toHaveOpenedModal`), `examples/agents/` |
| 2.2 Socket Mode works with Bolt | `test/acceptance/socket-mode.test.ts`: the DM and modal examples against the Bolt agent started in Socket Mode. `server/test/integration/slack-delivery.test.ts`: delivery cases S2–S5 over HTTP, and K1–K4 over the fake's WebSocket, received by Bolt | `server/src/core/delivery/` (a second transport), `server/src/drivers/slack/fake/socket.ts`, `server/src/serve.ts` (WebSocket upgrade) |
| 2.3 Standard checks | `test/acceptance/checks.test.ts`: `slackChecks({ app: "my-agent" })` passes against both reference agents; `test/acceptance/checks-broken.test.ts`: against `examples/agents/broken-slack` each check fails, one broken variant per check | `integrations/checks/`, `examples/agents/broken-slack/` |

Standing checks: `pnpm api:check` now covers every fake Slack example (the "later phases" list shrinks to "live mode").

## Order of work

1. Carried over from phase 1: `phase-log/phase-1/closed.md`, the status table in `docs/phases.md`.
2. Interactions over HTTP: `click`, `select`, `shortcut`, `runCommand` with `response_url`; delivery cases S2 and S4.
3. Views: `views.open` / `update` / `push`, `waitForModal`, `values`, `submit` (the agent's `response_action` from the HTTP response), `close`; delivery case S3.
4. Stop: `agent_session_stopped`, `chat.appendStream` answering `stopped_by_user`; delivery case S5.
5. The agent split view: `openAgentThread`, `pickPrompt`, `switchContext`, `suggestedPrompts()`.
6. Reference agents grow the handlers the examples need (approval buttons with an allowlist, a select menu, the incident modal, `/deploy`, the ticket shortcut, Stop, suggested prompts).
7. Socket Mode: `apps.connections.open`, the WebSocket endpoint, envelopes, acks with payloads, the `drop_socket` fault; delivery cases K1–K4; exit check 2.2.
8. `slackChecks()` and the broken agent; exit check 2.3.
9. Attach CLI: `slack click`, `slack stop`. UI: buttons in the transcript become clickable.
10. Docs.

## Reuse

| Concern | Module | Note |
|---|---|---|
| Sending to the agent, retries, forged deliveries | `server/src/core/delivery/` | Extended with a transport per delivery: HTTP (as now) or a driver-provided one (Socket Mode). No second queue. The response an interaction gets back (`response_action`, a command's immediate reply) is read from the attempt |
| Signing | `server/src/core/signing/slack.ts` | Interactions and commands are signed like events; only the body's encoding differs (form) |
| The one place state changes | `server/src/drivers/slack/fake/world.ts` | Clicks, selections, submissions and Stop are actions like `say`: written once here |
| Payload builders | `server/src/drivers/slack/payloads.ts` | `block_actions`, `view_submission`, `view_closed`, `message_action`, slash command form, `agent_session_stopped`, `assistant_thread_started`, `assistant_thread_context_changed` |
| Transcript controls | `server/src/drivers/slack/transcript.ts` | Buttons and menus already render as controls; finding one by label reuses that walk |
| Timers | `server/src/core/clock/` | `trigger_id` expiry (3 s), `response_url` lifetime |
| Ids | `server/src/core/ids/` | `slack.view`, `slack.trigger` exist since phase 0 |
| Matchers and waiting | `integrations/matchers-core/`, the SDK's `wait` | `toHaveOpenedModal` joins the existing matchers |
| Reference agents' shared parts | `examples/agents/shared/` | The scripted model gains the deploy, incident and ticket answers; both agents use them |
| new: `server/src/drivers/slack/fake/socket.ts` | Socket Mode: connections per app token, envelopes, acks | Nothing in core speaks WebSocket yet. The transport interface it implements belongs to `core/delivery` |
| new: `integrations/checks/` | `slackChecks()` | Planned in the code map for this phase. Built on the public SDK and matchers only |
| new: `examples/agents/broken-slack/` | An agent with one switchable fault per standard check | Exit check 2.3 needs a failing variant per check; `mdac-220` stays the single real-bug example |

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| none planned | | Bun serves WebSockets itself; Bolt's Socket Mode receiver (`@slack/socket-mode`) already comes with `@slack/bolt` | | |

Added to this table if that changes.

## Docs to update

- `docs/reality-matrix.md`: the interactivity and Socket Mode rows.
- `docs/devx.md`: the CLI section (`click`, `stop`).
- `docs/code-map.md` matches the code.
- Carried over from phase 1: `phase-log/phase-1/closed.md` and the status table in `docs/phases.md` (the phase 1 merge came before them).

## Open points to settle while building

- Issues #8 to #11 from phase 1 are not part of this phase unless the maintainer says so.
- What the real Slack sandbox did is recorded outside the repository (59 API exchanges, 38 events). Where the fake differs from it in what phase 1 built (event order for a mention, `streaming_state`, `thread_not_found`, `user_not_found`), the fix is small and goes in this PR as its own commits.
