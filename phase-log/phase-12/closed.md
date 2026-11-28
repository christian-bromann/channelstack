# Phase 12 closed

Pull request: [christian-bromann/channelstack#107](https://github.com/christian-bromann/channelstack/pull/107), squash-merged and tagged `phase-12-done`. Built on [decision 0027](../../docs/decisions/0027-multiple-apps.md) (#105).

## What was built

- **Any number of apps per channel**, on all seven channels and echo. Each app is a real app of its platform, with its own identity, credentials and endpoint.
  - `createApp({ name })` and `apps()`. `my-agent` stays the default.
  - Per-app secrets in `secrets.json` (`Secrets.forApp`) and ids (`IdGenerator.named`).
  - `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL`, and `channelstack env --app <name>`.
- **One owner in core** for what every channel shares about apps:
  - `core/apps` (`AppRoster`): which apps a session used, what a name means in a session, a handle by its id (`lookup`, `handle`), acting as an app (`scripted`), an app by its token (`withSecret`), its env (`forEnv`), the name rules and the limit.
  - The delivery kit, per app: `secret(app)`, `Outgoing.app`, `deliveries({ app })`, faults that name an app, and the app in the event log.
- **The loop guard** (`core/loops`). Every driver asks it on every bot write, and it stops a reply loop after `LOOP_LIMIT` (50) and logs `bot_loop`.
  - `/quiet` reports the loops.
  - `toGoQuiet` in Vitest, pytest and Rust.
  - Both fixtures fail a test that left a bot loop.
  - Each channel has a `no-reply-loop` check.
- **The platforms' bot-to-bot rules** per channel (12.3), and each app signed for alone with each platform's official receiver: delivery cases A1–A3 (12.4).
- **Acceptance**: the "several apps" examples on every channel, with the stack running a second agent as `coder` (12.2). `check:unchanged` holds every example and scenario of `phase-12-start` (12.1), and `check:channels` requires each channel's app cases (12.9).

## The gate

`pnpm verify:phase 12` passes in CI on the last head, with each acceptance part three times.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 30 | All fixed (38df7c7 to 20509a1); R1.21 was declined at first, then accepted (b56ae8c) |
| 2 | changes required | 4: the conflict with `main`, the sessions' apps, the PR body, the loop guard's wording | All fixed (the merge of `main`, 72f07e4, the PR body, 7da52a8) |
| 3 | changes required | 2: 1 blocking (the agent's own Slack DMs), 1 should-fix (a name where a handle goes) | All fixed (274887d, 6f57b48) |

Every thread is resolved. After three rounds no blocking finding is open, so the phase closes per the maintainer's rule. Round 3's fixes weren't reviewed in a later round.

## Deferred

- 12.11 and 12.13 (live): [christian-bromann/channelstack#111](https://github.com/christian-bromann/channelstack/issues/111). They need second sandbox apps, which have to be made by hand on each platform. Until then, the app routes are refused live with `unsupported_in_live`, held by exit check 5.4's test.

## For the maintainer

- The open questions of decision 0027 (D6 in AGENTS.md) were taken at their defaults.
- The dev session doesn't see the apps made with `channelstack env --app`. This was noted on the PR and left as it is.
