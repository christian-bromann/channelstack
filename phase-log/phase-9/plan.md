# Phase 9 plan: Google (Gmail)

Gmail as channel 6, on the channel kit and the email core of phase 8. The agent is a Gmail
mailbox it reads and sends from through the Gmail API (`googleapis`), told of new mail by Pub/Sub
pushes that carry an OIDC token it checks with `google-auth-library`. People are other mailboxes.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 9.1 Every fake Google example passes | `api/examples/google.test.ts` (all but "live mode"), against `examples/agents/gmail-node` | `api/google.d.ts`, `server/src/drivers/google/` (fake, routes, payloads), `scripts/lib/channels.ts` |
| 9.2 Gmail matches its schema | `server/src/drivers/google/google.test.ts`, and the acceptance run through `SCHEMAS` | `server/test/schemas/google.ts` (the pinned discovery document as JSON Schema), `server/test/schemas/gmail-discovery.json`, `scripts/google-schema.ts` |
| 9.3 Push tokens (M1–M3) | `server/test/integration/google-delivery.test.ts`: `verifyIdToken` against the binary's certificates | `drivers/google/signing.ts`, `drivers/google/fake/certs.ts`, `core/delivery/kit.ts` (`forge`) |
| 9.4 Standard checks | `test/acceptance/checks/google-checks.test.ts`, `test/acceptance/checks-broken.test.ts` | `integrations/checks/index.ts` (`GOOGLE_CHECKS`, `googleChecks()`), `examples/agents/broken-google` |
| 9.5 All channels in one run | `api/examples/shared.test.ts` | the harness table only |
| 9.6 The kit held | `pnpm check:channels`; the PR lists every file changed outside the Google driver, contract, agents, scenarios and docs | — |
| 9.7 Gmail live | the "live mode" block of `api/examples/google.test.ts` against the sandbox; `drivers/google/live/live.test.ts` against a stub | `drivers/google/live/` (client, identity, world, maintenance), `server/test/google-live-stub.ts`, `scripts/lib/live-agents.ts`, `.github/workflows/live.yml` |
| 9.8 Conformance | `scenarios/google/reply.yaml` in the differential run | `conformance/divergences.yaml` (`shapes/google`) |

## What the fake is

- **Hosts:** `gmail.googleapis.com` (`/gmail/v1/…`), `oauth2.googleapis.com` (`/token`) and
  `www.googleapis.com` (`/oauth2/v1/certs`, `/oauth2/v3/certs`), all at `google.localhost`.
- **The Gmail API `googleapis` calls:** `users.getProfile`; `users.messages` `list` (with `q`'s
  `from:`, `to:`, `subject:`, `is:unread`, `in:inbox`, `label:`, and `labelIds`), `get` (`full`,
  `metadata`, `minimal`, `raw`), `send` (`raw`, with `threadId`), `modify`, `trash`, `untrash`;
  `users.threads` `list`, `get`, `modify`, `trash`; `users.labels` `list`, `get`, `create`;
  `users.history.list` (`messageAdded`, `labelAdded`, `labelRemoved`; 404 for a `startHistoryId`
  before the mailbox's history); `users.watch` and `users.stop`. Google's error envelope
  `{ error: { code, message, errors[], status } }`, with `WWW-Authenticate` on a 401.
- **OAuth, only what the agent needs:** `POST /token` takes the `refresh_token` grant with the
  agent's client, and answers a fresh `ya29.` token for an hour. No sign-in flow.
- **Push:** with a `watch` on the fake's topic, each change to the agent's mailbox that matches the
  watch's labels is pushed to `CHANNELSTACK_GOOGLE_WEBHOOK_URL` in Pub/Sub's wrapped format, with
  an RS256 OIDC token (`iss` `https://accounts.google.com`, `aud` the push endpoint, the push
  service account's `email`, an hour's lifetime) signed by a per-install key, whose certificate
  is at `/oauth2/v1/certs` (PEM, what `verifyIdToken` reads under Node) and `/oauth2/v3/certs`
  (JWK). At most one push a second per mailbox, as Gmail; see the decision below. Pub/Sub's
  ack codes (102, 200, 201, 202, 204), its 10-second ack deadline, and its push backoff.
- **Ids:** message and thread ids are 16 hex characters; a history id is a growing decimal
  string with gaps; a Pub/Sub message id is 16 digits; user labels are `Label_<n>`.
- **Mail:** people's email is built as RFC 5322 MIME with `nodemailer`'s `MailComposer`, and the
  agent's raw sends are parsed with `postal-mime`. The `full` payload and `raw` come from the
  same message. Threads: in a mailbox, as Gmail does (the `threadId` the sender gives, a reply's
  `References` and a matching subject); in a test, the conversation by `In-Reply-To` and
  `References`, as Resend's (`core/email` `threadOf`).

## Reuse

| Concern | From |
|---|---|
| Driver definition, ids, secrets, token shapes | `DriverDefinition`, `idFormats` (`core/ids`), `SecretFormat` and `randomRsaPrivateKey` (`core/secrets`) |
| Deliveries: sending, retrying, resending, listing | `deliveryKit` and `fixedRetries` (`core/delivery/kit.ts`), extended with `forge` for a forgery only the platform makes (a token for another audience) |
| The REST API | `restApi` (`core/fake/endpoint.ts`) |
| Inspection routes | `registerInspectionRoutes` (`core/router/inspection.ts`) |
| Addresses, `Message-ID`s, threading, transcripts | `core/email` (`parseAddresses`, `formatMailbox`, `domainOf`, `localPartOf`, `messageId`, `messageIdsIn`, `replySubject`, `replyHeaders`, `threadOf`, `threadTranscript`); a MIME header reader joins it |
| The push certificate | `@peculiar/x509`, as `core/ca` uses it |
| Live clients | `LivePlatformRefusal` (`core/errors`), `waitRetryAfter`, `RATE_LIMIT_RETRIES` (`core/clock`), `core/reality`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` |
| Schema checks | the `SCHEMAS` registry (`server/test/schemas/index.ts`) |
| Everything Resend's people do | the shapes of `drivers/resend/` (`world.ts`, `backend.ts`, `mail.ts`, `routes.ts`) and `api/email.d.ts` |

New, with why nothing existing fits:
- `server/src/drivers/google/`: the driver, the only place Gmail's rules live.
- `server/test/schemas/google.ts`: Gmail publishes a discovery document, not OpenAPI; its schemas
  become JSON Schema there (a `$ref` by name, `int64` and `uint64` as strings, no property the
  document doesn't list).

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `nodemailer` (server) | 10.5.0 | Builds RFC 5322 messages (`MailComposer`): encodings, folding, multipart alternatives. Pure JS | MIT-0 | Released 2026-11-10 |
| `googleapis` (dev) | 189.0.0 | The reference agent's Gmail client, and the M1–M3 receiver's | Apache-2.0 | Released 2026-10-30 |
| `google-auth-library` (dev) | 11.3.3 | `OAuth2Client`, `verifyIdToken`: the agent's token refresh and push check | Apache-2.0 | Released 2026-11-03 |
| Gmail discovery document (vendored) | `googleapis/discovery-artifact-manager` at `e64e26ab87c7d621285fb6ab4e448436da3dffcb`, revision `20261106` | Gmail's own description of its API, for 9.2 | Apache-2.0 | — |

## Decisions

- **One push a second, held rather than dropped** ([decision 0022](../../docs/decisions/0022-gmail-push-rate.md)):
  Gmail drops notifications above one a second per mailbox. The fake sends at most one a second
  too, but holds a change that comes sooner and pushes it at the end of that second with the
  newest history id, per test session, so tests that run side by side don't hold each other up
  and an agent that lists history from its last id misses nothing.
- **`rootUrl` per API:** `googleapis` ignores `google.options({ rootUrl })`, and its per-API
  `rootUrl` doesn't reach media uploads. The docs tell agents to pass `rootUrl` to
  `google.gmail(…)` and send `{ raw }`; proxy mode covers an agent that can't.
- **A `watch` sends no push of its own in the fake:** Gmail sends one right away, but an agent
  watches when it starts, outside any test's session.

## Docs to update

The same list as phase 8, for Google: AGENTS.md is already current; `docs/reality-matrix.md`
(`## Google`), `docs/live-mode.md` (credentials table), `docs/devx.md` tables,
`docs/architecture.md` (id table), `docs/code-map.md` (rows for the driver), the website's
platform page and the API reference (generated), the guides that list the channels,
`website/docs/reference/environment-variables.md`, README, `index.html`, the skill.

## Changed while building

- **The email kit grew.** Resend's routes, people and records were the template for Google's, and
  copying them was a duplicate. What both email channels have moved into `core/email`:
  `store.ts` (`EmailStore`: the agent's mailbox, people, emails, conversations, `addPerson`),
  `routes.ts` (`registerEmailRoutes` over an `EmailWorld`: the fixture, people who send, reply and
  read their inbox, the conversations), `mime.ts` (`composeMime`, `parseMime`, `mimeHeaders`), and
  `replyOf` and `emailAuthor` in `index.ts`. Resend moved onto them; its spec is unchanged.
- **`rootPaths`.** `googleapis` rebuilds each URL as an absolute path against `rootUrl`, dropping
  any path in it, so without portless (each fake under a path prefix) it can't reach the fake. A
  driver now declares the paths its SDK keeps at the root (`/gmail/v1/`), and the server serves
  them at its root too; `GOOGLE_API_URL` is the fake's origin.
- **The delivery kit's `forge`.** A resend can carry a forgery only the platform makes: a Pub/Sub
  token for another audience (`wrongAudience`), counted as forged like a bad signature.
- **`restApi` reads form bodies and answers 204 empty:** Google's token endpoint takes a form, and
  Gmail's `users.stop` answers nothing.
- **History ids aren't drawn.** The id generator keeps every id unique, and a gap drawn from 1 to 40
  ran out after 40 changes and looped. A history id grows by a gap from its count instead.
- **The pinned descriptions share one script**, `scripts/pinned-schema.ts` (`resend:schema`,
  `google:schema`).
- **`google.history` doesn't run live**: it counts replies exactly, which needs proxy mode live.
