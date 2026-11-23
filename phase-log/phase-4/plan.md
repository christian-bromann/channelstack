# Phase 4 plan

Goal: the Linear and Notion fakes. Every fake Linear and Notion example passes, and every channel runs in one suite.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 4.1 Every fake Linear example passes | `api/examples/linear.test.ts`, everything but "live mode", unchanged, against `examples/agents/linear-sdk` and `examples/agents/chat-sdk-linear` (`pnpm test:accept`) | `server/src/drivers/linear/`, `integrations/matchers-core/` (the Linear matchers), `integrations/vitest/` (the `linear` fixture) |
| 4.2 Every fake Notion example passes | `api/examples/notion.test.ts`, everything but "live mode", unchanged, against `examples/agents/notion-sdk` | `server/src/drivers/notion/`, the Notion matchers, the `notion` fixture |
| 4.3 Linear matches its schema | `server/src/drivers/linear/linear.test.ts` (every answer and webhook of the unit tests, held to the committed schema by `server/test/linear-workspace.ts`), and `test/acceptance/linear-schemas.setup.ts` (every GraphQL call and every webhook of each acceptance test) | `server/test/linear-schema.ts` (the one validator), `server/src/drivers/linear/schema/` |
| 4.4 Signatures | `server/test/integration/linear-delivery.test.ts` (L1 to L3, `LinearWebhookClient`), `server/test/integration/notion-delivery.test.ts` (N1 to N3, `verifyWebhookSignature`) | `server/src/core/signing/linear.ts`, `notion.ts`; `core/delivery` (a body stamped per attempt) |
| 4.5 Standard checks | `test/acceptance/checks/linear-checks.test.ts`, `notion-checks.test.ts` against the reference agents; `test/acceptance/checks-broken.test.ts` against `examples/agents/broken-linear` and `broken-notion` | `integrations/checks/` |
| 4.6 All channels in one run | `api/examples/shared.test.ts` against a stack with one reference agent per channel | `scripts/lib/stack.ts` (several agents), `scripts/examples.ts` |

## Order of work

1. Linear: the schema (fetched from Linear's repository at a pinned commit, committed, and embedded for the binary), the GraphQL endpoint on graphql-js, the workspace, people, teams, issues, comments, delegation, agent sessions and activities, the webhooks.
2. Linear's control API, SDK, fixture and matchers; the reference agent; 4.1 and 4.3.
3. Notion: the REST surface `@notionhq/client` uses at `2025-09-03`, pages and blocks (Markdown in and out), databases and data sources, comments and discussions, connections, the webhooks with the handshake and batching.
4. Notion's control API, SDK, fixture and matchers; the reference agent; 4.2.
5. Delivery cases (4.4), the standard checks and the broken agents (4.5), the stack with every agent (4.6).
6. Docs.

## Reuse

| Concern | Module | Note |
|---|---|---|
| Sending webhooks, attempts, redelivery, forged signatures | `server/src/core/delivery/` | Extended once: a delivery may stamp its body per attempt (Linear's `webhookTimestamp` is inside the signed body), and a resend can be sent as if at another time (a stale one) |
| HMAC and constant-time compare | `server/src/core/signing/hmac.ts` | new: `signing/linear.ts` (`Linear-Signature`), `signing/notion.ts` (`X-Notion-Signature`), as the code map plans |
| Ids | `server/src/core/ids/` | `linear.uuid`, `notion.uuid` and `linearIdentifier` exist since phase 0 |
| Secrets | `server/src/core/secrets/` | `linear.oauthToken`, `linear.webhookSecret`, `notion.token`, `notion.verificationToken` exist; new: `linear.clientId`, `linear.clientSecret` |
| Sessions, registry, event log, quiet | `server/src/core/` | As GitHub uses them; calls about nothing a session owns go to `WORLD_SCOPE` |
| Routes, waits, matchers, checks | `core/router/`, `codegen/`, `integrations/` | The new matchers join `matchers-core`; `toHaveCommentFrom` reads a Notion comment's `text` as well as a body |
| The stack | `scripts/lib/stack.ts` | Extended to start several agents, one per channel (exit check 4.6) |
| new: `server/src/drivers/linear/` | The driver, with the files every driver has; `fake/graphql.ts` executes operations against the schema | GraphQL is Linear's own protocol; nothing in the repository speaks it yet |
| new: `server/src/drivers/notion/` | The driver; `markdown.ts` turns Markdown into Notion blocks (with `marked`'s lexer) and blocks into Markdown | Notion's own block model |
| new: `server/test/linear-schema.ts` | Holds a GraphQL response, and a webhook payload, to the committed schema | Test-only |

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `graphql` (server) | 16.15.0 | Parsing, validating and executing GraphQL against Linear's schema. The reference implementation | MIT | Released 2026-11 |
| `marked` (server) | 18.2.0 | Its lexer reads Markdown for page content; nothing is rendered to HTML | MIT | Released 2026-11 |
| `@linear/sdk` (dev) | 103.0.0 | Reference agent; `LinearWebhookClient` is the receiver in L1 to L3 | MIT | Released 2026-11 |
| `@notionhq/client` (dev) | 5.31.1 | Reference agent; `verifyWebhookSignature` is the receiver in N1 to N3; its response types check the fake's builders | MIT | Released 2026-11 |
| `@chat-adapter/linear` (dev) | 4.45.0 | The second Linear reference agent, on the Chat SDK in agent-session mode | MIT | Released 2026-11 |

`@notionhq/client` is also a dev dependency of `server`: the fake's builders are typed by its response and webhook types (type imports only). `@chat-adapter/notion` was dropped: it calls `https://api.notion.com/v1` with no base URL option, so it can't reach the fake in base-URL mode (it can in proxy mode, phase 5).

Linear's schema is a data file, not a dependency: `server/src/drivers/linear/schema/schema.graphql`, from `linear/linear` at a pinned commit (`scripts/linear-schema.ts` fetches it and writes the module the binary embeds).

## Docs to update

- `docs/reality-matrix.md`: the Linear and Notion rows.
- `docs/devx.md`: close the Notion items of "Still open" (none are left there; the Notion v0.1 item is already under "Settled since the first draft").
- `docs/code-map.md` matches the code.

## Decisions taken in this phase

Recorded in `docs/decisions/` as they are made.
