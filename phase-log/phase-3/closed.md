# Phase 3 closed

Pull request: [christian-bromann/channelstack#14](https://github.com/christian-bromann/channelstack/pull/14), squash-merged on 2026-11-22 and tagged `phase-3-done`.

## What was built

- **The GitHub fake:** the REST surface Octokit, Probot and the Chat SDK's GitHub adapter use (repositories, contents and the Git Data API, issues, pull requests, reviews and threads on the diff, reactions, labels, assignees, check runs and statuses, the App's own endpoints with its delivery log and redelivery), served at the API root and under `/api/v3`.
- **Git in memory with real SHAs** (isomorphic-git on memfs), with patches, merge, squash and rebase.
- **App webhooks** with GUIDs and `X-Hub-Signature-256`; the App hears about a repository only while it is installed there.
- **Control API and SDKs** for what people do on GitHub, the `github` fixture and the GitHub matchers. The generator learned what the surface needed: a resource that extends another, file inputs, an object given by one field, ids that aren't strings.
- **`githubChecks()`:** 6 standard checks. Both reference agents pass them, and each fails against the agent with that fault.
- **Reference agents:** Probot, and the Chat SDK with its GitHub adapter.

## The gate

All four CI jobs passed on the last head: `verify:phase (linux-x64)` with the acceptance suite 3 of 3, both packaging jobs, and the compile of all five targets. Exit checks 3.1 to 3.5 each have a test; phase-log/phase-3/plan.md maps them. Every REST response and webhook in the unit tests and in the acceptance run is held to GitHub's published schemas.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 12 (2 blocking, 8 should-fix, 2 nits) | All fixed; the Python part of one deferred to an issue |
| 2 | changes required | 11 (1 blocking, 8 should-fix, 2 nits) | All fixed |
| 3 | changes required | 11 (7 should-fix, 4 nits) | All fixed |

There is no "Verdict: approved" review on the PR. The maintainer's rule for this project is to merge after three rounds when no blocking finding is open; none was open after round 3. Every thread is resolved.

## Deferred

- [#15](https://github.com/christian-bromann/channelstack/issues/15): Python tests for the file runtime and the GitHub methods (with the pytest setup of phase 7).
- [#16](https://github.com/christian-bromann/channelstack/issues/16): `mergeable` is always true; the session-less call log has no limit; a fully deleted thread stays in `resolvedThreads`.

## For the maintainer

Two choices of this phase depart from what the documents said, and are yours to overrule (both are in the PR description and in decision 0013):

- The control API addresses a repository by its numeric id, not by `owner/repo`.
- The fake lets a test assign the App's bot and request its review, because the contract takes the app there. The reality matrix had said the fake refuses both; whether GitHub does is not verified.

Contract changes in `api/`: actions return `GitHubDelivery | undefined`; `GitHubCommit.author` can be undefined (one example reads it as `fix.author?.name`); `github.appCalls()`; `GitHubIssue.repoId`, `GitHubRepo.private`, `GitHubUser.displayName` and `role`, `GitHubCheckRun.actions`; the fixture directory `api/examples/fixtures/web/`.

Not checked against GitHub, only recalled: the wording of the 422 messages for review comments, that a check run created as completed sends `created` and then `completed`, and which id `in_reply_to_id` names after a thread's first comment is deleted.

## Decisions

docs/decisions/0013 (the GitHub fake: names, ids, the App and what stays unverified).
