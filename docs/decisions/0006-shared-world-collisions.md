# 0006: Fixed names, fixed ids and global actions in the shared world

Status: accepted, phase 1. Decided by the maintainer.

## Context

There is one fake workspace per channel, and every test is a session inside it (AGENTS.md, "World"). Three things in the public API reach past a session: a name the test fixes (`createChannel({ name: "support" })`), an id the test fixes (`createUser({ id: "U0ADMIN01" })`), and actions on the one shared app (`slack.uninstallApp()`, the `drop_socket` fault). The documents didn't say what happens when two parallel sessions meet there.

## Decision

- **Names are unique per session, not per workspace.** Two sessions can each have a `#support`. The agent sees two channels with different ids and the same name. Inside one session the platform's rule holds: a second `#support` is refused with Slack's `name_taken`.
- **Fixed ids are unique in the world.** The agent can't tell two `U0ADMIN01` apart, so a second session that asks for an id another open session holds is refused with `invalid_argument`, and the message names the id. The id is free again when the session that holds it closes. Tests that fix the same id must not overlap.
- **Global actions apply to the whole world and are undone when their session closes.** `uninstallApp` reinstalls the app with the same tokens when the session ends; a fault a session set is removed with it. While the test runs, other sessions see the effect, so such tests run on their own: the docs and the examples say so, and the acceptance suite runs them in a serial group.

## Why

- **Parallel tests are the main path.** devx.md promises that fixtures with fixed names work in parallel; scoping names to the session keeps that promise without making tests invent unique names.
- **Ids are identity.** An agent that allowlists `U0ADMIN01` must get exactly one such person, so there the platform's rule wins over convenience.
- **Undo is cheaper than refusal.** Refusing a global action while other sessions are open would make those tests fail under any parallel runner; undoing it at session end keeps them usable and leaves the world as it was.

## Alternatives considered

- **Names unique per workspace, like real Slack.** Rejected by the maintainer: tests with fixed names could not run in parallel.
- **Waiting for a fixed id to be free.** Rejected: a hidden queue makes slow tests and hides the conflict.
- **Refusing global actions when another session is open.** Rejected: see above.

## Known difference from the real platform

Real Slack refuses a second channel with the same name in a workspace. The fake allows it across sessions. The reality matrix records this as a fake-only difference.
