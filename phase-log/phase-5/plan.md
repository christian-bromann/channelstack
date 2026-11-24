# Phase 5 plan

Live mode: act on the real platforms and read the results back, never relay to the agent ([live-mode.md](../../docs/live-mode.md)).

## What this PR can and can't finish

Only a Slack sandbox exists (a developer workspace with the agent's app and one person, Ana). GitHub, Linear and Notion have none yet, and the CI secrets, the deployed agents and the test inbox for unattended sign-in are things only the maintainer can set up. So this PR builds everything that needs no new credentials, makes Slack live end to end, and flags the rest as **needs maintainer**:

| Exit check | In this PR | Needs the maintainer |
|---|---|---|
| 5.1 Live examples pass | Slack: the live adapter, and the nightly job that runs the Slack live block against real Slack. The agent receives over Socket Mode inside the job, so it needs no public URL | The `live` environment's secrets in CI; GitHub, Linear and Notion sandboxes and their agents at public URLs |
| 5.2 Cleanup is complete | The ledger, `channelstack sweep`, `sweep --check --run <id>` after the nightly job | Same secrets |
| 5.3 Allowlists hold | Done here: unit test | — |
| 5.4 Fake-only features say so | Done here: every "No" and "Not yet" row refuses with `unsupported_in_live`, and the Vitest integration skips the step with the reason | — |
| 5.5 Live spike recorded | V1 (Slack) run against the sandbox and recorded | V2–V5 need the other sandboxes and the browser actor |
| 5.6 Unattended sign-in | `channelstack doctor` checks saved sessions | The browser actor needs a test inbox (Slack, Notion) and passkeys (GitHub, Linear) |

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 5.1 | `api/examples/*.test.ts` "live mode" blocks in `.github/workflows/live.yml` (nightly) | `drivers/slack/live/*`, `core/reality`, `core/safety`, `core/ledger`, `core/secrets` (live vault), `integrations/vitest/setup.ts`, SDK `credentials` |
| 5.2 | `server/src/core/ledger/ledger.test.ts`, `server/src/drivers/slack/live/live.test.ts` (cleanup and sweep against a Slack-shaped stub); `channelstack sweep --check` in `live.yml` | `core/ledger`, `drivers/slack/live/cleanup.ts`, `cli/live.ts` |
| 5.3 | `server/src/drivers/slack/live/live.test.ts` ("allowlists") | `core/safety`, `drivers/slack/live/world.ts` |
| 5.4 | `server/test/live-unsupported.test.ts` (every matrix row marked No / Not yet), `integrations/vitest` skip test in `test/acceptance/live-skip.test.ts` | `core/router/route.ts` (`live` on a route), `core/reality`, every driver's routes |
| 5.5 | The matrix's "Still to confirm" list and the Slack rows | `docs/reality-matrix.md` |
| 5.6 | `server/src/cli/live.test.ts` (doctor on saved sessions) | `cli/live.ts` |

## Reuse

| Concern | From the code map |
|---|---|
| Refusing with a stable code | `core/errors/` (`ProtocolError`), new codes `unsupported_in_live`, `action_requires`, `live_not_allowlisted`, `fake_actor_in_live_world`, `cross_workspace_credential` |
| Live credentials in memory | `core/secrets/` (the code map plans it there): `LiveCredential`, which never serializes |
| Scrubbing tokens | `core/redact/` (live tokens are registered with the redactor) |
| The ledger file | `core/home/` (0600, atomic writes) |
| Retry waits on a 429 | `core/clock/` (`Timers`) |
| Session close | `core/sessions/` (gains awaited close listeners for live cleanup) |
| Slack mentions | `drivers/slack/mentions.ts` |
| What a person reads | `drivers/slack/transcript.ts`, unchanged: live records go through the same renderer |
| Polling, timeouts | SDK `wait` (unchanged) |
| Finding the server, the dev session | `cli/attach.ts` |

New:
- `core/reality/`: fake or live per driver, the route's live support, the refusals. Nothing existing decides reality.
- `core/safety/`: allowlists and the run tag.
- `core/ledger/`: what live sessions created, cleanup in reverse order, the file `sweep` reads after a crash.
- `drivers/slack/live/`: `client.ts` (Web API calls, rate limits), `world.ts` (the live `SlackWorld`), `cleanup.ts` (deleting what the ledger lists, and the tagged channels `sweep` finds).
- `cli/live.ts`: `doctor` and `sweep`.
- SDK runtime `credentials` (TypeScript and Python): `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN` lookup, planned in the code map.

## Design in one paragraph

A driver declares its live credentials (`CHANNELSTACK_SLACK_APP_ID`, `CHANNELSTACK_SLACK_BOT_TOKEN`) and its allowlist variable. With all of them set (and `CHANNELSTACK_REALITY` not `fake`), the driver is live: its routes go to the live `World` instead of the fake one. Each route says whether it works live (`live` on the route): fake-only and "Not yet" routes are refused by the router with `unsupported_in_live` and the reason, browser and proxy routes with `action_requires`, before any driver code runs. The Slack `World` keeps its lookups of what a session made (people, conversations) synchronous and makes actions and reads awaitable, so one interface serves both backends. A live driver checks the app's credentials and allowlist once (`auth.test`) before its first action; a person's token is checked when the person is created. Everything created live is recorded in the ledger and removed when the session closes.

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `@notionhq/client` (server, now a runtime dependency) | 5.31.1 | Notion's own client for the live Notion world: requests with one credential each, paging and rate-limit retries. It was already the server's dev dependency for the fake's response types, and the reference agents use it | MIT | Yes |
| `webdriverio` (server) | 10.2.0 | The browser actor: a real browser driven as a person over WebDriver BiDi, for what only a platform's client does. Already the repo's browser for the UI acceptance test | MIT | Yes |
| `pytest` (Python SDK, dev only) | 8.4.2 | The Python runtime's own tests (`sdks/python/tests`), the counterpart of the TypeScript runtime's Vitest tests (review finding R1.10) | MIT | Yes |

No runtime dependency. The Slack Web API is called with `fetch`: the server needs a dozen methods, and `@slack/web-api` would bring axios and its own retry logic into the binary.

## Docs to update

- `docs/reality-matrix.md` (all live cells)
- `docs/live-mode.md`
- `docs/devx.md` section 10
- `docs/code-map.md` (reality, safety, ledger, live secrets, Slack `live/`, SDK `credentials`, `cli/live.ts`)
- `docs/decisions/0015-live-mode.md`
