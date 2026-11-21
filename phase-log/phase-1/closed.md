# Phase 1 closed

Pull request: [christian-bromann/channelstack#5](https://github.com/christian-bromann/channelstack/pull/5), squash-merged as `b7bdcd2` on 2026-11-21 and tagged `phase-1-done`.

## What was built

- **The Slack fake for core conversations:** the Web API an agent uses (`auth.test`, `chat.*` with streams, `conversations.*`, `users.*`, `reactions.*`, `assistant.threads.*`, `agents.sessions.*`, the app's side of files upload v2), signed HTTP delivery with Slack's own retries, the event log with attribution to sessions, faults and uninstall.
- **The control API and SDKs** for people: create users and channels, say, reply (also to the channel), edit, delete, react, DMs, invite and kick, and the reads and waits on messages, threads, streams, deliveries and transcripts.
- **`channelstack/vitest`:** the plugin, a session and fixtures per test, and the matchers; negative and exact-count matchers wait for quiet (decision 0009).
- **Tools:** the attach CLI (`slack say`, `reply`, `react`, `show`, `tail`, `ui`), and UI v0 behind a one-time login link (decision 0008).
- **Reference agents:** Bolt with the AI SDK, a Chat SDK bot, and the deliberately broken `mdac-220`.
- **The gate:** `pnpm api:check`, the acceptance tests for exit checks 1.4 to 1.7, `verify:phase 1` in CI.

## The gate

All four CI jobs passed on `7db4bfb`, the last head a review round looked at: `verify:phase (linux-x64)` with the acceptance suite 3 of 3, both packaging jobs, and the compile of all five targets. Exit checks 1.1 to 1.7 each have a test; phase-log/phase-1/plan.md maps them. Exit check 1.3 covers delivery cases S1 and S6 to S8; S2 to S5 moved to exit check 2.2, confirmed by the maintainer.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 12 (4 blocking, 5 should-fix, 3 nits) | 11 fixed; R1.8 confirmed by the maintainer |
| 2 | changes required | 5 (2 should-fix, 3 nits) | All fixed |
| 3 | changes required | 14 (1 blocking, 7 should-fix, 6 nits) | 13 fixed, 1 deferred to issues |
| 4 | not finished | — | The maintainer merged while round 4 was running |

There is no "Verdict: approved" review on the PR: the maintainer merged it directly. Every thread from rounds 1 to 3 is resolved.

## Deferred

- [#8](https://github.com/christian-bromann/channelstack/issues/8): a person uploads files (`ana.say({ files })`).
- [#9](https://github.com/christian-bromann/channelstack/issues/9): `SlackThread.root` is in the contract but not in the generated handle.
- [#10](https://github.com/christian-bromann/channelstack/issues/10): config loading has no phase.
- [#11](https://github.com/christian-bromann/channelstack/issues/11): `api:check` should compare every contract member with the generated SDK.

Not checked against Slack's reference, only recalled: no `app_mention` for a DM with the app, and upload URLs that take bytes without a token.

## Decisions

docs/decisions/0006 (shared-world collisions), 0007 (Vitest 5), 0008 (UI access), 0009 (what quiet means to a check), 0010 (the dev session and the attach CLI), 0011 (the reference agents).
