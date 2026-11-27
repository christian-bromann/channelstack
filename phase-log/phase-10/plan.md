# Phase 10 plan: Twilio (Programmable Messaging, SMS)

Twilio as channel 7, on the channel kit. The agent owns a Twilio number. People text it; Twilio
posts each message to the agent's webhook, form-encoded and signed with `X-Twilio-Signature`. The
agent answers through the Messages API (`POST /2010-04-01/Accounts/{AccountSid}/Messages.json`,
basic auth with the Account SID and Auth Token, or an API key), or with TwiML in its answer to the
webhook. Twilio tells it what became of each message through status callbacks.

Phase 11 (Discord) is built at the same time, in its own pull request, at the maintainer's request
([decision 0025](../../docs/decisions/0025-twilio.md)). Whichever merges second merges `main` in and
resolves the shared files.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 10.1 Every fake Twilio example passes | `api/examples/twilio.test.ts` (all but "live mode"), against `examples/agents/twilio-node` | `api/twilio.d.ts`, `server/src/drivers/twilio/` (fake, routes, payloads, transcript), `scripts/lib/channels.ts` |
| 10.2 Twilio matches its schema | `server/src/drivers/twilio/twilio.test.ts`, and the acceptance run through `SCHEMAS` | `server/test/schemas/twilio.ts`, `server/test/schemas/twilio-api-v2010.json`, `scripts/pinned-schema.ts` (`twilio`) |
| 10.3 Signatures | Delivery cases T1–T4 ([appendix](../../docs/phases.md#appendix-delivery-cases)) against the real fake, with the `twilio` SDK's `validateRequest` and `MessagingResponse` as the receiver | `drivers/twilio/signing.ts`, `drivers/twilio/fake/world.ts`, `core/signing/hmac.ts`, `core/delivery` |
| 10.4 Standard checks | `test/acceptance/checks/twilio-checks.test.ts`, `test/acceptance/checks-broken.test.ts` | `integrations/checks/index.ts` (`TWILIO_CHECKS`, `twilioChecks()`), `examples/agents/broken-twilio` |
| 10.5 All channels in one run | `api/examples/shared.test.ts` | the harness table only |
| 10.6 The kit held | `pnpm check:channels`; the PR lists every file it changed outside the Twilio driver, contract, agents, scenarios and docs | — |
| 10.7 Twilio live | the "live mode" block of `api/examples/twilio.test.ts` against the sandbox; `drivers/twilio/live/live.test.ts` against a stub; a recipient outside the allowlist refused with `live_not_allowlisted` before any call | `drivers/twilio/live/` (client, identity, world, cleanup, maintenance), `server/test/twilio-live-stub.ts`, `scripts/lib/live-agents.ts`, `.github/workflows/live.yml` |
| 10.8 Conformance | `scenarios/twilio/reply.yaml` in the differential run | `conformance/divergences.yaml` |

## What the fake is

- **Host:** `api.twilio.com` at `twilio.localhost`. The `twilio` SDK has no base-URL setting; an
  agent gives it an `httpClient` (`twilio.RequestClient`) that sends `https://api.twilio.com` to
  `TWILIO_API_URL`, the way Twilio's docs show a custom client. Proxy mode covers an agent that
  can't.
- **The account:** one Account SID (`AC…`), its Auth Token, an API key (`SK…` and its secret), the
  agent's number (`PN…`, E.164), and a Messaging Service (`MG…`) with that number in its sender
  pool. Twilio's test credentials too (a second Account SID and Auth Token), with which the magic
  numbers (`+15005550006` and the others) do what Twilio documents and nothing is sent.
- **The REST API the agent calls**, on `restApi`, form bodies: `messages.create` (`To`, `From` or
  `MessagingServiceSid`, `Body`, `MediaUrl`, `StatusCallback`), `messages.list` (`To`, `From`,
  `DateSent`, paging), `messages.fetch`, `messages.update` (redacting the body), `messages.remove`,
  `accounts.fetch`, `incomingPhoneNumbers.list`. Twilio's refusals (`{ code, message, more_info,
  status }`): 20003 (authentication, with `WWW-Authenticate`), 20404, 20008 (test credentials on a
  read), 21211, 21212, 21266, 21602, 21603, 21604, 21606, 21610 (opted out), 21612, 21614, 21617
  (over 1600 characters), 21408, 21611. A `Twilio-Request-Id` (`RQ…`) on every answer. Dates in
  RFC 2822, as Twilio writes them.
- **Messages:** SIDs in Twilio's format (two letters, 32 hex); E.164 numbers; segments counted as
  Twilio does (GSM-7 with its extension table, 160 or 153 per segment; UCS-2 for anything else, 70
  or 67); `num_segments`, `num_media`, `price` in USD once sent.
- **Inbound webhook:** a person's text is posted to `CHANNELSTACK_TWILIO_WEBHOOK_URL`,
  form-encoded, with every parameter Twilio sends (`MessageSid`, `SmsSid`, `SmsMessageSid`,
  `AccountSid`, `MessagingServiceSid`, `From`, `To`, `Body`, `NumMedia`, `NumSegments`,
  `SmsStatus`, `ApiVersion`, the geographic fields), signed with `X-Twilio-Signature`: HMAC-SHA1
  with the Auth Token over the URL and the sorted parameters, base64. With
  `I-Twilio-Idempotency-Token` (the same on a retry), `User-Agent: TwilioProxy/1.1`. Twilio's
  timeouts and retries, with its connection overrides in the URL's fragment (`#ct`, `#rt`, `#tt`,
  `#rc`, `#rp`; default 15 s, one retry on a connection failure); the signature is over the URL
  without the fragment.
- **TwiML:** an XML answer to the webhook (`<Response><Message>…</Message></Response>`, `<Body>`,
  the `to`, `from` and `statusCallback` attributes) sends each `<Message>`, as Twilio does, through
  the same checks as the API. A retry's answer is acted on too.
- **Status callbacks:** for a message with a `StatusCallback`, `queued`, `sent`, then `delivered`,
  `undelivered` (a person whose phone is off: `reachable: false`, error 30003) or `failed`, each
  signed the same way over the callback's URL.
- **Opt-out:** a person who texts `STOP` (or `UNSUBSCRIBE`, `END`, `QUIT`, `CANCEL`, `STOPALL`)
  gets Twilio's own answer, the agent's webhook gets the text with `OptOutType=STOP`, and the
  agent can't text them again (21610) until they text `START`. `HELP` gets Twilio's answer too.
- **WhatsApp:** later. The Messages API is the same, but a fake WhatsApp sender needs templates,
  the 24-hour session window and its own statuses (`read`); that's not cheap on top of SMS.
- **MMS:** `MediaUrl` is taken and counted (`num_media`); the Media subresource is later.

## The contract

`api/twilio.d.ts`: the `twilio` fixture (`app`, the agent's number; `createUser`, a person with a
phone number), `TwilioUser.text(body, { to })`, `messages()` (what reached their phone) and
`waitForMessage`; `TwilioMessage` (body, from, to, segments, status, error code, its delivery);
`TwilioConversation`, the messages between two numbers, a `HasTranscript` with `messages`,
`replies`, `waitForReply` and `latestReply`; `TwilioDelivery` (`message` for an incoming text,
`status` for a status callback) with `redeliver` (Twilio's retry) and `resend({ badSignature })`.

## Live

- The app is the agent's Twilio account and number (`CHANNELSTACK_TWILIO_ACCOUNT_SID`,
  `CHANNELSTACK_TWILIO_AUTH_TOKEN`, `CHANNELSTACK_TWILIO_NUMBER`). Each person is another number
  that can send: `CHANNELSTACK_TWILIO_USER_<NAME>_TOKEN` is `<AccountSid>:<AuthToken>` of the
  account that owns it (the agent's own, or a second account), and
  `CHANNELSTACK_TWILIO_USER_<NAME>_NUMBER` the number, unless that account has one allowlisted
  number besides the agent's.
- `CHANNELSTACK_LIVE_TWILIO_NUMBERS` allowlists the numbers. Every recipient outside it is refused
  with `live_not_allowlisted` before any call: an SMS can't be taken back, and it costs money.
- What a session sends and reads back is on the ledger and deleted when it closes (Twilio keeps
  messages until they are deleted); the sweep deletes what a crashed run's ledger lists.
- channelstack never relays, forwards or synthesizes a webhook to the agent: Twilio posts to the
  relay the agent's number points at.

## Reuse

| Concern | From |
|---|---|
| Driver definition, ids, secrets, token shapes | `DriverDefinition`, `idFormats` (`core/ids`), `SecretFormat` and `hex`, `alnum` (`core/secrets`) |
| Deliveries: sending, retrying, resending, listing | `deliveryKit` and `fixedRetries` (`core/delivery/kit.ts`) |
| Signing | `core/signing/hmac.ts` (a base64 HMAC-SHA1 joins it), `constantTimeEqual` |
| The REST API | `restApi` with `{ form: true }` (`core/fake/endpoint.ts`) |
| Inspection routes | `registerInspectionRoutes`, `refTo`, `pathParam`, `DeliveryView` (`core/router`) |
| Transcripts, principals, calls | `transcriptSchema`, `principalSchema`, `apiCallSchema`, `DeliveryAttempt`, `DeliveryStatus` (`core/router/inspect.ts`), `iso` (`core/clock`) |
| Live clients | `LivePlatformRefusal` (`core/errors`), `waitRetryAfter`, `RATE_LIMIT_RETRIES` (`core/clock`), `core/reality`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` |
| Schema checks | the `SCHEMAS` registry (`server/test/schemas/index.ts`), `scripts/pinned-schema.ts` |

New, with why nothing existing fits:
- `server/src/drivers/twilio/`: the driver, the only place Twilio's rules live.
- `server/test/schemas/twilio.ts`: Twilio's description is OpenAPI 3.0 (`nullable`, its own
  formats `phone-number` and `date-time-rfc-2822`), and describes no webhook; the webhook's
  parameters are held to the Message resource's schemas of the fields they carry.

## Changes to the kit

- `deliveryKit`: a delivery's own ack window (`timeoutMs`), for Twilio's connection overrides; the
  signer is handed the delivery's URL, which Twilio's signature covers.
- `DeliveryQueue.again`: `answered`, so a platform that acts on the answer to its own retries
  (Twilio sends a retry's TwiML) gets it on a redelivery too.

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `twilio` (dev) | 6.3.0 | The reference agent's client, `validateRequest` and `MessagingResponse`, and the delivery cases' receiver | MIT | Released 2026-11-06 |
| `fast-xml-parser` (server) | 5.12.0 | Reads the TwiML an agent answers with: entities, CDATA, attributes. Pure JS | MIT | Released 2026-11-03 |
| Twilio's OpenAPI description (vendored) | `twilio/twilio-oai` at `6891362428239e2b29339718ffb7bd9fb86ff9cb`, `spec/json/twilio_api_v2010.json` | Twilio's own description of its API, for 10.2 | MIT | Released 2026-11-05 |

## Docs to update

- `AGENTS.md` (the Channels and Addresses rows), `docs/code-map.md`, `docs/adding-a-channel.md` (the kit's changes);
- `docs/reality-matrix.md` (`## Twilio`), `docs/live-mode.md` (section 4), the `devx.md` tables, `docs/architecture.md`'s id table;
- `docs/decisions/0025-twilio.md`, phase 10 in `docs/phases.md` with its delivery cases;
- the environment-variable reference, the Twilio platform page, README, `index.html`, the skill.

## Changed while building

- **A message's words are `text`,** as every other channel's: the matchers read `text`. The SDK's
  method that sends is still `ana.text(body, { to })`.
- **Live credentials are `<Account SID>:<Auth Token>`,** one string per account, for the agent
  (built from its two variables) and each person, so one client call takes one credential. API
  keys work in the fake; live people use their account's token.
- **One OpenAPI answer check** (`server/test/schemas/openapi.ts`): Twilio's would have repeated
  Resend's; Resend moved onto it.
- **The live run's relay puts a form back** (`asForm` in `scripts/lib/live-agents.ts`): smee.io's
  client posts a form's fields as JSON. Both relay steps share one local hop.
- **`check:channels` reads CI's matrix as YAML:** with a seventh part the formatter wraps the list.
- **`PREFIXED_TOKENS` takes a two-letter prefix**, so a live Twilio credential (`AC…:…`) is in the
  redaction checks; the redactor scrubs whatever follows `Basic` too.
- **Decision 0025, not 0022:** 0022 to 0024 were taken on `main`.
- **The PR is titled `feat(server)`:** the `PR title` check runs on `pull_request_target`, so it
  reads `main`'s scopes; this PR adds `twilio` for the ones after it.
