# Phase 1 plan

Goal: the Slack fake, core conversations. The Slack conversation examples pass against Bolt and Chat SDK reference agents.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 1.1 Conversation examples pass | `api/examples/slack.test.ts`: "mentions and threads", "direct messages", "reactions, edits and deletes", "inspecting what the agent did", and "streams a reply and shows a status while working", run by `pnpm test:accept` against `examples/agents/bolt-ai-sdk` and `examples/agents/chat-sdk-slack` | `server/src/drivers/slack/`, `integrations/vitest/`, `integrations/matchers-core/`, `examples/agents/` |
| 1.2 Delivery basics | `api/examples/slack.test.ts`, "delivery and failures": the 3 s retry, bad and stale signatures, rate limit, uninstall (the Socket Mode test is phase 2) | `server/src/core/delivery/`, `server/src/drivers/slack/` |
| 1.3 The fake signs like Slack | `server/test/integration/slack-delivery.test.ts`: cases S1–S8, the fake's real delivery code received by a Bolt app | `server/src/core/signing/slack.ts`, `server/src/core/delivery/` |
| 1.4 A real bug is caught | `test/acceptance/mdac-220.test.ts`: the stream and status test run against `examples/agents/mdac-220` fails, and the message names the leftover "Thinking…" message | `integrations/matchers-core/`, `examples/agents/mdac-220` |
| 1.5 Negative matchers wait for quiet | `integrations/vitest/quiet.test.ts`: a reply 500 ms after a `.not.toHaveReplyFrom` started makes it fail; one after `quietFor` doesn't | `server/src/core/quiet/`, `integrations/matchers-core/` |
| 1.6 CLI and UI | `test/acceptance/cli-ui.test.ts`: `channelstack slack say --as ana --in "#support" "@my-agent hi"`, then `channelstack show` prints the agent's reply; a browser opens the UI and finds the same reply | `server/src/cli/`, `ui/` |
| 1.7 Parallel sessions are isolated | `test/acceptance/parallel.test.ts`: 20 copies of the DM test in parallel, every one passes, no cross-session events | `server/src/core/sessions/`, `server/src/drivers/slack/` |

Standing checks added in this phase: `pnpm api:check` (the examples type-check against the generated TypeScript SDK and the integrations, not only against `api/*.d.ts`), and `pnpm test:accept --repeat 3` now runs the `api/examples` suites as well as the smoke scenarios.

## Order of work

1. Decisions 0006 and 0007; the contract change for Vitest 5.
2. Slack store, `World`, control routes, ids and secrets; unit tests through `app.fetch`.
3. Slack fake Web API (`auth.test`, `chat.*` with streams, `conversations.*`, `users.*`, `reactions.*`, `assistant.threads.*`, `agents.sessions.setStatus`, basic files v2).
4. Delivery: Slack signing, retries with `X-Slack-Retry-*`, resend with a bad or stale signature, faults; exit check 1.3 against Bolt.
5. Transcripts and the quiet detector.
6. `integrations/matchers-core` and `integrations/vitest`; `api:check`.
7. Reference agents; exit checks 1.1, 1.2, 1.4, 1.5, 1.7.
8. `channelstack env`, the attach CLI and UI v0; exit check 1.6.
9. Docs: reality matrix, devx.md.

## Reuse

| Concern | Module | Note |
|---|---|---|
| Sessions, registry, event log and cursors, errors, redaction, logging, state directory, clock | `server/src/core/…` (phase 0) | Used as they are |
| Ids: `slack.user`, `slack.channel`, `slack.dm`, `slack.mpim`, `slack.event`, `slack.file`, `slackTs`, `reserve` | `server/src/core/ids/` | Built in phase 0. `reserve` gains a release when its session closes (decision 0006) |
| Secrets: `slack.botToken`, `slack.appToken`, `slack.signingSecret` | `server/src/core/secrets/` | Formats built in phase 0 |
| HMAC and constant-time compare | `server/src/core/signing/hmac.ts` | Slack v0 signing is a new file next to it, `signing/slack.ts` |
| Delivery queue | `server/src/core/delivery/` | Extended: retries, resend, forged signatures, faults, per-delivery reads. No second sender |
| Route registration and the driver contract | `server/src/core/router/` | Extended where the Slack routes need more (unions, nested path parameters) |
| The echo driver | `server/src/drivers/echo/` | The file-for-file template for `drivers/slack/` |
| Polling and durations | `sdks/typescript/runtime/{wait,duration}.ts` | Every matcher and `waitFor…` uses `waitFor` |
| Starting the binary in tests | `scripts/lib/server.ts`, `server/test/integration/harness.ts` | Used by the acceptance runner |
| new: `server/src/core/quiet/` | Quiet detector | Planned in the code map for this phase |
| new: `server/src/core/config/` | Loading `channelstack.config.ts` and the Slack manifest | No phase owned config loading; the Slack app's scopes, events and URLs come from it |
| new: `integrations/matchers-core/`, `integrations/vitest/` | Matchers and the Vitest plugin | Planned in the code map for this phase |
| new: `ui/` | UI v0 | Planned in architecture.md |
| new: `examples/agents/` | Reference agents | Planned in implementation-plan.md 13 |

## Decisions taken in this phase

- `docs/decisions/0006-shared-world-collisions.md`: fixed names, fixed ids and global actions in the shared world.
- `docs/decisions/0007-vitest-version.md`: the Vitest integration targets Vitest 5.

## New dependencies

Filled in as they are added; each with version, reason and license.

| Package | Version | Where | Why a library and not our code | License |
|---|---|---|---|---|
| `@slack/bolt` | 5.1.0 | reference agents, exit check 1.3 | The official receiver the fake must satisfy | MIT |
| `ai` | 7.0.177 | reference agent | Streaming and the framework's mock model | Apache-2.0 |
| `chat`, `@chat-adapter/slack`, `@chat-adapter/state-memory` | 4.45.0 | reference agent | The Chat SDK Slack adapter | MIT |
| `webdriverio` | 10.2.0 | exit check 1.6 | The browser test for the UI | MIT |
| `yaml` | 2.9.1 | server | Reading a real Slack manifest (already a development dependency) | ISC |

## Docs to update

- `docs/reality-matrix.md`: mark the Slack fake rows done.
- `docs/devx.md` if any API changed.
- `docs/code-map.md` matches the code.
- Carried over from phase 0: `phase-log/phase-0/closed.md` and the status table in `docs/phases.md` (the phase 0 merge came before them).
