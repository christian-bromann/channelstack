# 0021: Email channels: Resend and Google (Gmail)

Status: accepted, 2026-11-25, on the maintainer's instruction. It reopens the settled "Channels" row in AGENTS.md.

channelstack adds two email channels: **Resend** (phase 8) and **Google**, which fakes Gmail (phase 9). People email the agent, and it answers in the same thread. Both are built on the channel kit, which phase 8 also builds and moves the four existing channels onto.

## Why these two

The most-downloaded single-service packages of Vercel's emulate project, on 2026-11-25:

| Package | Last week | Last 30 days |
|---|---|---|
| `@emulators/resend` | 149,690 | 328,850 |
| `@emulators/google` | 103,265 | 321,692 |
| `@emulators/slack` | 44,079 | 143,412 |
| `@emulators/github` | 22,340 | 86,516 |

People already test against fakes of these two, and email is a channel agents live in. Support desks, schedulers and triage agents answer email the way others answer in Slack. `docs/audience.md` keeps outbound-only SaaS calls out of scope. An email agent is in scope when people write to it and it answers.

## What "Google" covers

Gmail only, and Google's token endpoint only as far as the agent's own access token.
- **emulate's Google package is mostly OAuth sign-in.** Its OAuth work has 90 issues and PRs, against 19 for Calendar, 15 for Gmail and 13 for Drive. Signing users into an app isn't a conversation, so it stays out.
- **Gmail is emulate's biggest agent surface:** messages, threads, drafts, labels, history and watch, about 950 lines of routes. Calendar has about 135 and Drive about 125.
- **Google Chat is left for later.** emulate doesn't have it, and its Chat apps need a Business or Enterprise Workspace domain for live mode.

The channel is named `google`, not `gmail`, so Calendar, Drive or Chat can join the same channel later.

## What "Resend" covers

Resend's receiving API (`email.received`, then `GET /emails/receiving/{id}`) and sending (`POST /emails` with `In-Reply-To` and `References`). Not Resend's Inboxes, which is in private beta; it can be added once it's generally available. emulate's Resend has no receiving and no Svix-signed webhooks.

## Renamed: the delivery resend options

`ResendOptions`, `SlackResendOptions` and `LinearResendOptions`, the options of `delivery.resend()`, become `DeliveryResendOptions`, `SlackDeliveryResendOptions` and `LinearDeliveryResendOptions`. A channel named `resend` has types like `ResendUser`, and the old names would read as its types. `delivery.resend()` keeps its name.

## Two stacked pull requests

Phase 9's pull request branches from phase 8's and is retargeted to `main` once phase 8 merges. This overrides AGENTS.md's "one phase at a time" for these two phases, at the maintainer's request. Each still has its own review rounds, and phase 9 only merges after phase 8.

## Live safety

Sent email can't be taken back, and a sweep can't delete it from a recipient's mailbox. In live mode both channels refuse a recipient outside their allowlist (`CHANNELSTACK_LIVE_RESEND_DOMAINS`, `CHANNELSTACK_LIVE_GOOGLE_ADDRESSES`) before calling the platform. Run tags go in the subject and in an `X-Channelstack-Run` header.

## Alternatives considered

- **Leave email for after 0.1** (the earlier recommendation). The maintainer chose to add it now.
- **Google Chat instead of Gmail.** It's closer to Slack, but emulate has none, and live mode needs a Workspace domain.
- **One generic SMTP/IMAP email channel.** Agents call a provider's API, not SMTP, and the point is to fake what they call.
