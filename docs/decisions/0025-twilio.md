# 0025: Twilio (Programmable Messaging, SMS) as channel 7

Status: accepted, 2026-11-27, on the maintainer's instruction. It reopens the settled "Channels" row in AGENTS.md, as [decision 0021](0021-email-channels.md) did for email.

channelstack adds **Twilio** (phase 10): people text the agent's Twilio number, Twilio posts each text to the agent's webhook, and the agent answers through the Messages API or with TwiML. Discord is phase 11, decided on its own.

## What "Twilio" covers

Programmable Messaging, SMS first:
- **Inbound texts:** the agent's number's messaging webhook, form-encoded and signed with `X-Twilio-Signature` (HMAC-SHA1 with the Auth Token over the URL and the sorted parameters). Twilio's timeouts and retries, with the connection overrides a webhook URL carries in its fragment.
- **Answers:** `POST /2010-04-01/Accounts/{AccountSid}/Messages.json`, with basic auth (the Account SID and Auth Token, or an API key), from the number or its Messaging Service; or TwiML in the answer to the webhook.
- **Status callbacks:** `queued`, `sent`, then `delivered`, `undelivered` or `failed`, at the `StatusCallback` the agent gave.
- **What Twilio refuses**, with its error codes and shape, its test credentials and magic numbers, E.164, the 1600-character limit and segments, and its default opt-out handling (`STOP`, `START`, `HELP`).

Not Voice, Conversations or Verify. Voice is a call, not a conversation a test reads; Conversations is a different product with its own API and webhooks; Verify is sign-in.

## SMS, and WhatsApp later

WhatsApp goes through the same Messages API (`whatsapp:+1…` addresses), but a fake of it isn't cheap on top of SMS: approved templates outside the 24-hour session window, the window itself, `read` statuses, and a sandbox that each person joins with a code. It is recorded as later. MMS is taken (`MediaUrl`, counted in `num_media`); the Media subresource is later too.

## The SDK has no base URL

The `twilio` Node SDK builds every URL from `https://api.twilio.com`, with only a region and an edge to change. An agent tested in base-URL mode gives the SDK an `httpClient` (a `twilio.RequestClient` that rewrites the origin to `TWILIO_API_URL`), as Twilio documents for a proxy. Proxy mode covers an agent that can't, with `api.twilio.com` among the routed hosts.

## Two phases at once

Phases 10 and 11 are built at the same time, each in its own pull request, at the maintainer's request. This overrides AGENTS.md's "one phase at a time" for these two phases. Each has its own review rounds. Both touch the files that list the channels (the phases, the code map, the reality matrix, the harness table, the driver registry, the CI matrix); whichever merges second merges `main` in and resolves them.

## Live safety

A text can't be taken back, and it costs money. Live mode refuses a recipient outside `CHANNELSTACK_LIVE_TWILIO_NUMBERS` before calling Twilio, and checks the agent's number and each person's against it when they join. Each person is a number of their own on an account their token opens: a second number on the agent's account, or another account. A text carries no tag, so every message a session saw goes on the ledger and is deleted when the session closes (Twilio keeps messages until they are deleted), and the sweep deletes what a crashed run's ledger lists.

## Decision numbers

0022 to 0024 were taken on `main` when this was written; Twilio takes 0025 and Discord the next free one.

## Alternatives considered

- **Twilio Conversations** instead of Programmable Messaging: one API for SMS, WhatsApp and chat, but most agents that answer texts use the Messages API and its webhook, and Conversations is a different set of webhooks to fake.
- **WhatsApp first:** more agents talk to people there, but its rules (templates, the window) are most of the work, and SMS is what every Twilio number does.
- **An XML parser of our own for TwiML:** `fast-xml-parser` reads it (entities, CDATA, attributes) and is pure JavaScript, so it goes into the binary; the fake refuses a document with a DTD before reading it.
