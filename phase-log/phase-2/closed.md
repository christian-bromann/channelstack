# Phase 2 closed

Pull request: [christian-bromann/channelstack#12](https://github.com/christian-bromann/channelstack/pull/12), squash-merged on 2026-11-21 and tagged `phase-2-done`.

## What was built

- **Slack interactivity in the fake:** buttons and select menus (`block_actions`), message shortcuts, slash commands, `response_url` answers, modals (`views.open`, `push`, `update`, submissions with `response_action`, close), Stop on an agent's work, and the agent split view with suggested prompts and context changes.
- **Socket Mode:** `apps.connections.open`, the app's WebSocket, envelopes and acknowledgements, as a second transport of the one delivery queue; the `drop_socket` fault, with `after`.
- **Delivery cases S2 to S5 and K1 to K4** against Bolt, moved here from exit check 1.3.
- **Control API and SDKs:** `click`, `select`, `shortcut`, `runCommand`, `stop`, `openAgentThread`, `pickPrompt`, `switchContext`, `waitForModal` and the modal handle; acting and reading wait like a person (`retryWhile`, `onceQuiet`).
- **`slackChecks()`:** 13 standard checks. Both reference agents pass them, and each fails against the agent with that fault.
- **CLI:** `slack click` and `slack stop`.

## The gate

All four CI jobs passed on the last head: `verify:phase (linux-x64)` with the acceptance suite 3 of 3, both packaging jobs, and the compile of all five targets. Exit checks 2.1 to 2.3 each have a test; phase-log/phase-2/plan.md maps them.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 11 (1 blocking, the rest should-fix and nits) | All fixed |
| 2 | changes required | 13 (8 should-fix, one of them reopened from round 1; 5 nits) | All fixed |
| 3 | changes required | 7 (2 should-fix, 5 nits) | 6 fixed, 1 deferred to an issue |

There is no "Verdict: approved" review on the PR. The maintainer's rule for this project is to merge after three rounds when no blocking finding is open; none was open after round 2 or round 3. Every thread is resolved.

## Deferred

- [#13](https://github.com/christian-bromann/channelstack/issues/13): `waitForModal` can return a modal that is already closed (R3.5).

Contract additions in `api/`: `ChecksOptions.streamPrompt` and `approval`; `SlackFixture.socketConnections`, `SlackUser.modals()`, `SlackModal.open` and `errors`.

Not checked against Slack's reference, only recalled: `stopped_by_user` as the error after Stop, the fields of `agent_session_stopped`, the defaults of a `response_url` answer, and `not_allowed_token_type`.

## Decisions

docs/decisions/0012 (interactions, Socket Mode and the standard checks).
