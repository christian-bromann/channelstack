# Phase 8 plan

The channel kit, the email core and Resend ([phases.md](../../docs/phases.md#phase-8-the-channel-kit-the-email-core-and-resend), [decision 0021](../../docs/decisions/0021-email-channels.md)). Phase 9 (Google) is a pull request stacked on this one.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 8.1 Every channel is on the kit | `pnpm check:channels` (new `scripts/check-channels.ts`), in the static group | `core/router/driver.ts` (`title`, `typePrefix`, `internal`, `ids`, `secretFormats`, `tokenPatterns`), `drivers/index.ts` (`CHANNELS`), new `core/delivery/kit.ts`, new `core/router/inspection.ts`, new `core/fake/`, `core/errors` (`PlatformRefusal`), `core/live` (`retryAfter`), `core/ids`, `core/secrets`, `core/redact`, the signers moved into the drivers, codegen emitters for fixtures and channel unions, new `scripts/lib/channels.ts`, `server/test/schemas/`, and each of the four drivers moved onto all of it |
| 8.2 Every fake Resend example passes | `api/examples/resend.test.ts` against `examples/agents/resend-node` | new `server/src/drivers/resend/`, new `server/src/core/email/`, `api/email.d.ts`, `api/resend.d.ts` |
| 8.3 Resend matches its schema | `server/test/schemas/resend.ts` (Ajv over the pinned `resend-openapi`) in the unit tests and the acceptance setup | new `server/src/drivers/resend/schema/`, `scripts/resend-schema.ts` |
| 8.4 Signatures (R1–R3) | `server/test/integration/resend-delivery.test.ts`, with the `resend` SDK's `webhooks.verify` | `drivers/resend/signing.ts`, the delivery kit |
| 8.5 Standard checks | `test/acceptance/checks/resend-checks.test.ts`, `test/acceptance/checks-broken.test.ts` | `integrations/checks` (`resendChecks`), `examples/agents/broken-resend/` |
| 8.6 All channels in one run | `api/examples/shared.test.ts` | the harness table |
| 8.7 Resend live | the "live mode" block of `api/examples/resend.test.ts` in the live job; `drivers/resend/live/live.test.ts` against `server/test/resend-live-stub.ts` (allowlist before any call) | new `drivers/resend/live/` |
| 8.8 Conformance | `scenarios/resend/reply.yaml` in `pnpm conformance` | `conformance/shapes.ts` (Resend's webhook taps), `divergences.yaml` |

## Reuse

| Concern | Module |
|---|---|
| Sending deliveries, attempts, retries, redelivery and forged copies | `core/delivery` `DeliveryQueue`; the kit only wraps it |
| HMAC and constant-time compare | `core/signing/hmac.ts` |
| Ids, secrets and their CSPRNG, the registry, sessions | `core/ids`, `core/secrets`, `core/registry` |
| Recording calls, transcripts, principals | `core/router/inspect.ts` |
| The control API routes and the SDK extensions | `core/router/route.ts` `DriverRouter` |
| Live: reality, vault, people, ledger, allowlist, run tags, doctor and sweep | `core/reality`, `core/secrets/live.ts`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` |
| Email addresses in output | `core/redact` `EMAIL_PATTERN` |
| Validating against a pinned schema | the GitHub validators' Ajv setup (`server/test/github-schemas.ts`), behind the new registry |
| New: `core/delivery/kit.ts`, `core/router/inspection.ts`, `core/fake/` | The same code exists four times in the drivers; it moves here and the copies are deleted |
| New: `core/email/` | Resend and Google both need MIME, threading and email transcripts; drivers can't import each other |
| New: `scripts/lib/channels.ts` | The harness's per-channel facts are spread over eight scripts |

## New dependencies

Each pinned to an exact version at least two weeks old.

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `postal-mime` (server) | 4.2.1 | Parses MIME messages (multipart, encodings, headers): what the fakes receive as `raw` and what a test's email carries. No dependencies, runs in Bun, and the `resend` SDK uses it too | MIT-0 | Released 2026-11-10 |
| `resend` (dev: reference agent and tests) | 6.38.0 | The official SDK, as the reference agent's client and the R1–R3 receiver | MIT | Released 2026-11-10 |
| `resend-openapi` (vendored file, by commit) | pinned SHA | Resend's own OpenAPI description, to validate answers and webhooks | MIT | Updated with the API |

## Changed while building

- **MIME moved to phase 9.** Resend's API answers JSON, so this phase only parses addresses (`postal-mime`); `nodemailer` comes with Gmail's `raw` format. Resend's attachments and a received email's raw message are #64.
- **The kit's names.** `providerEndpoint` is `restApi` (Notion, echo and Resend use it), `PlatformRefusal` is `LivePlatformRefusal` (core already had a `PlatformRefusal` type), `retryAfter` is `waitRetryAfter`. `defineFake` wasn't built: each fake's seeding is its platform's own.

## Docs to update

(From the phase section.)
- `AGENTS.md` (channels and addresses rows), `docs/audience.md`, `docs/adding-a-channel.md` (new), `docs/code-map.md`
- `docs/reality-matrix.md`, `docs/live-mode.md` section 4, the `docs/devx.md` tables, `docs/architecture.md`'s id table
- the environment-variable reference, the Resend platform page, README, `index.html`, `skills/channelstack/SKILL.md`
