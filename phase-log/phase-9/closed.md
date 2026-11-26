# Phase 9 closed

Pull request: [christian-bromann/channelstack#66](https://github.com/christian-bromann/channelstack/pull/66), squash-merged on 2026-11-26 and tagged `phase-9-done`.

## What was built

- **Google (Gmail)**, channel 6, on the channel kit and the email core of phase 8:
  - The fake Gmail API, as `googleapis` calls it:
    - messages, with `q` and every format; threads, Gmail-threaded; labels, with the agent's own made, changed and deleted; history; `watch` and `stop`; the profile.
    - Google's token endpoint for the `refresh_token` grant, and the push certificates as PEM and JWK.
    - Answers held to Gmail's discovery document, pinned by commit (9.2).
  - Pushes in Pub/Sub's wrapped format, with RS256 OIDC tokens a receiver checks with `verifyIdToken` (M1–M3, 9.3). At most one push a second per session, held rather than dropped ([decision 0022](../../docs/decisions/0022-gmail-push-rate.md)). Pub/Sub's backoff, and forgeries that combine: another key, expired, another audience.
  - `api/google.d.ts` and its examples (9.1). The `gmail-node` reference agent and `broken-google`, `googleChecks()` (9.4), Google in `shared.test.ts` (9.5).
  - Live (9.7):
    - Each person is a Gmail account of their own, and every recipient is allowlisted before a send.
    - Gmail's ids are kept per mailbox, and an email read back once by its `Message-ID`. An email's labels come from its copy in the agent's mailbox.
    - Each session labels its threads with a label of its own, on the ledger, and deletes it when it closes. The sweep removes what a crashed run left.
  - `pnpm google:token` writes a mailbox's refresh token into `live.env`, signing in with PKCE.
- **The kit grew where Gmail needed it**, and `check:channels` holds every channel to it (9.6):
  - `rootPaths`, for an SDK that drops a base URL's path.
  - The delivery kit's `forge`.
  - Form bodies, only where an endpoint takes one.
  - Shapes keyed by ids.
  - The email kit: store, routes, MIME, `mirror`. Resend moved onto it.
  - One `live.env` reader and writer.
  - One list of prefixed tokens for both redaction checks.
- **Verified against real Gmail** on 2026-11-25 and 2026-11-26 (9.7, 9.8), with two consumer accounts and a Pub/Sub topic pushing through a relay. The live example passes with nothing left behind. The differential run of `scenarios/google/reply.yaml` finds no difference, and one shape divergence is allowed: `refresh_token_expires_in`, for an OAuth client in Testing.
  - Gmail files mail from a new address as spam, so each sandbox account needs a filter that never sends the other's mail to spam (in the reality matrix).

## The gate

`pnpm verify:phase 9` passes in CI on the last head, with each acceptance part three times.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 19: 3 blocking (a second `live.env` reader and writer, form bodies for every REST fake, the code map), 7 should-fix, 9 nits | 17 fixed; R1.5 (sign with `jose`, which signs only asynchronously) declined, and the decline accepted; R1.4 fixed, its second half declined, and the decline accepted |
| 2 | changes required | 6: 2 should-fix (the run's label never deleted, the PR's file list), 4 nits | All fixed |
| 3 | changes required | 8: 1 blocking (the live worlds' `keep` written twice), 1 should-fix (a sent message joined a thread without `threadId`), 6 nits | All fixed |

Every thread is resolved. After three rounds no blocking finding was open, so the phase closes on the round 3 fixes, per the maintainer's rule.

## For the maintainer

- The sandbox's OAuth client is still in Testing, so its refresh tokens expire after 7 days. Publish it, then run `pnpm google:token` again for each account.
- `pnpm live:secrets` copies the Google variables to the `live` environment for the nightly job.
