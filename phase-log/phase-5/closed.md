# Phase 5 closed

Pull request: [christian-bromann/channelstack#18](https://github.com/christian-bromann/channelstack/pull/18), squash-merged on 2026-11-24 and tagged `phase-5-done`.

## What was built

- **Reality per driver:** a driver is live when its declared credentials are set and `CHANNELSTACK_REALITY` isn't `fake` (`core/reality`). The router refuses what doesn't work live from each route's `live` declaration, before any driver code runs: `unsupported_in_live` or `action_requires`, with the reason. The Vitest integration skips such a test and gives the reason.
- **Safety:**
  - Allowlists per platform.
  - The run tag in every live name (`core/safety`).
  - The cleanup ledger, one file per server (`core/ledger`).
  - Live credentials that never turn into text (`core/secrets/live.ts`).
- **Live worlds for all four channels.** Each keeps a mirror in the fake's record shapes, and people act with their own tokens.
  - **Slack:** the browser actor types a person's messages, because Slack marks every API post with the posting app's bot.
  - **GitHub:** the App's installation on the test org makes each session's repositories.
  - **Notion:** each session's pages go under a page of its own, made below the page the integration is connected to.
  - **Linear:** each session makes its own teams, and Linear opens the agent session once its webhook reaches the agent.
- **Shared by every live world:**
  - `core/maintenance`: doctor's checks and the sweep.
  - `core/people`: the real people of open sessions. Only a session that holds a person acts as them.
  - `pollUntil` in `core/clock`.
  - `taggedNames` in `core/safety`.
  - `checkRoles` in `core/reality`.
- **The browser actor** (`core/browser`): WebdriverIO drives headless Chrome over BiDi. Each person gets one browser for the whole server and acts one step at a time, starting from a session they saved with `channelstack login`.
- **Commands:**
  - `channelstack doctor`, `channelstack sweep` and `channelstack login`.
  - `pnpm live`, which runs every reference agent, with GitHub's, Notion's and Linear's behind smee.io relay channels.
  - `pnpm live:secrets`.
  - The nightly `.github/workflows/live.yml`.

## The gate

`pnpm verify:phase 5` passes in CI on the last head: static, unit, both packaging jobs, the compile of all five targets, and the acceptance parts three times each. Locally, all five live examples passed against the four sandboxes with `pnpm live`.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 15 inline (2 blocking, 7 should-fix, 6 nits), plus the summary's | All fixed |
| 2 | changes required | 3 inline (1 should-fix, 2 nits), plus one in the summary | All fixed |
| 3 | approved | none blocking | — |
| 4 | changes required | 21 (4 blocking, 12 should-fix, 5 nits), after Notion, GitHub and Linear went live | All fixed |
| 5 | changes required | 8 (2 blocking, 3 should-fix, 3 nits) | All fixed |

Round 3 approved the Slack-only phase. Rounds 4 and 5 covered the other three live worlds and the browser actor. Every blocking finding of round 5 is fixed, with a test, and every thread is resolved.

## Deferred

These exit checks can't be met before the merge, so they are tracked as issues:

- 5.1 (the nightly live job passes on `main`): [christian-bromann/channelstack#19](https://github.com/christian-bromann/channelstack/issues/19). All five live examples pass locally.
- 5.2 (the sweep check after the nightly job): [christian-bromann/channelstack#20](https://github.com/christian-bromann/channelstack/issues/20). Unit-tested for each driver; the local sweep check found nothing left.
- 5.5 (the live spike): [christian-bromann/channelstack#21](https://github.com/christian-bromann/channelstack/issues/21).
  - Passed: V1, and V4's click.
  - Open: V2's p95, V4's Stop, and the matrix's still-open questions.
- 5.6 (unattended sign-in): [christian-bromann/channelstack#22](https://github.com/christian-bromann/channelstack/issues/22). Needs a test inbox and passkeys.

## For the maintainer

- **Slack:**
  - A person's message is typed in Slack's client, live (decision 0015).
  - A DM with an app in the agent view is one long thread. Cleanup leaves the app's answers there for the session that closes last, when an earlier message may be theirs.
- **GitHub:** the delivery log shows a delivery a few seconds after it was sent, so the live example polls `github.deliveries()`.
- **Contract changes in `api/`:**
  - `api/linear.d.ts`: a session's `delivery` and what `prompt` and `answer` resolve with are fake-only.
  - `api/slack.d.ts`: `click` resolves with `undefined` live.
  - `api/notion.d.ts`: `NotionComment.delivery` is fake-only.
