# Phase log

Each phase is one pull request on [christian-bromann/channelstack](https://github.com/christian-bromann/channelstack). Reviews, replies and their resolution happen **on the PR**. This folder keeps the two files that belong in the repository:

| File | Written by | When | Skill |
|---|---|---|---|
| `phase-<n>/plan.md` | Implementer | First commit of the phase PR | `implement-phase` |
| `phase-<n>/closed.md` | Implementer | Last commit before merge, after a review round says approved | `implement-phase` |

A phase is done when its PR is merged: gate green in CI, the latest review says **Verdict: approved**, no unresolved review threads, every box in the PR body ticked, and the tag `phase-<n>-done` set on `main`. See [AGENTS.md](../AGENTS.md#how-to-work).
