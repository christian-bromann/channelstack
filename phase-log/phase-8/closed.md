# Phase 8 closed

Pull request: [christian-bromann/channelstack#57](https://github.com/christian-bromann/channelstack/pull/57), squash-merged on 2026-11-25 and tagged `phase-8-done`. Phase 9 (Google) is stacked on it.

## What was built

- **The channel kit** ([adding-a-channel.md](../../docs/adding-a-channel.md)): what every driver repeated now lives in core, and Slack, GitHub, Linear, Notion and echo are on it, with their own copies deleted.
  - One channel list (`CHANNELS`, `x-channelstack-channels`), from which the SDKs' unions and fixtures, the Vitest and pytest fixtures and the Rust matcher subjects are generated.
  - Drivers declare their id and secret formats and token shapes; core names no platform, and the redactor is built from the drivers' `tokenPatterns`.
  - `deliveryKit` and `fixedRetries`, `registerInspectionRoutes`, `LivePlatformRefusal`, `waitRetryAfter`.
  - A REST fake's API: `restApi` (Notion, echo, Resend) and `wrapRest` (GitHub's own routes), with `bodyOf` and one call recorder. Slack's form-posted Web API and Linear's GraphQL endpoint record their calls themselves.
  - One harness table (`scripts/lib/channels.ts`) and per-channel schema validators (`server/test/schemas/index.ts`).
  - `pnpm check:channels` (8.1): every piece a channel needs exists, and no driver goes around the kit.
  - The delivery option types renamed: `DeliveryResendOptions`, `SlackDeliveryResendOptions`, `LinearDeliveryResendOptions`.
- **The email core** (`server/src/core/email`): addresses on `postal-mime`'s parser, `Message-ID`s, threading by `In-Reply-To` and `References`, and a thread as a person reads it. Contract bases in `api/email.d.ts`.
- **Resend**, channel 5:
  - The fake: sending, batches, idempotency, the receiving API, domains, Resend's refusals and its 10-a-second limit, the `@resend.dev` test addresses, and Svix-signed webhooks retried on Resend's schedule. Answers and webhooks are held to `resend/resend-openapi`, pinned by commit.
  - `api/resend.d.ts` and its examples; the `resend-node` reference agent and `broken-resend`; `resendChecks()`; delivery cases R1–R3 with the official SDK as receiver.
  - Live: each person is a Resend team of their own, every recipient checked against `CHANNELSTACK_LIVE_RESEND_DOMAINS` before anything is sent, the agent's answers read back from each person's received mail. It passes against real Resend, and conformance shows no differences beyond the recorded ones.
- **Found on the way:** email addresses in error data and URL-encoded in the request log weren't redacted; both are now, and `test:redaction` checks them.

## The gate

`pnpm verify:phase 8` passes in CI on the last head, with each acceptance part three times.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 16 (5 blocking: Notion off `restApi`, gaps in `check:channels`, an allowlist test that missed the allowlist, fake shapes off the description, a 429 after sending. 6 should-fix, 5 nits) | 15 fixed, R1.12 deferred to #65 |
| 2 | changes required | 4 (1 blocking: no test reached the live send guard; 2 should-fix, among them GitHub off `restApi`; 1 nit) | All fixed |
| 3 | changes required | 2 (1 should-fix: `wrap` asked for hooks it didn't use; 1 nit) | Both fixed |

Every thread is resolved. After three rounds no blocking finding was open, so the phase closes on the round 3 fixes, per the maintainer's rule.

## Deferred

- [#64](https://github.com/christian-bromann/channelstack/issues/64): Resend attachments and the raw MIME download.
- [#65](https://github.com/christian-bromann/channelstack/issues/65): HTML to text on a maintained library.
