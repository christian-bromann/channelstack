# Adding a channel

A channel is its driver folder, its contract, its agents and its docs. Everything else (the
channel list, the SDKs' unions and fixtures, the Vitest and pytest fixtures, the inspection routes,
the acceptance parts) comes from those. `pnpm check:channels` names what is still missing, so the
order below is also the order its failures come in.

The kit the driver is built on, all in `server/src/core/`:

| What | Where |
|---|---|
| Ids in the platform's format | `idFormats("resend", { … })` in the driver's `ids.ts`, on the definition as `ids`; shapes from `core/ids` (`uuid`, `numeric`) |
| Tokens and signing secrets | the driver's `secrets.ts` (`SecretFormat`s, helpers from `core/secrets`), named by the definition's `secrets`; their shapes as `tokenPatterns`, real tokens the fake never makes as `liveTokens` |
| Webhooks | the driver's `signing.ts` on `core/signing/hmac.ts`; `deliveryKit(context, { driver, timeoutMs, retry: fixedRetries([...]), stamp, sign, secret })` sends, resends and lists them |
| Deliveries and calls routes | `registerInspectionRoutes(router, { title, delivery, filters, redeliver, resend, calls, … })` |
| A REST platform's fake API | `restApi(context, { driver, authorize, refusal, invalidJson, notFound })` from `core/fake/endpoint.ts`: each endpoint authorized, its body parsed, a refusal answered in the platform's shape, the call on record |
| Route helpers | `refTo`, `pathParam`, `Awaitable`, `DeliveryView` from `core/router`; `iso` from `core/clock` |
| Live clients | `LivePlatformRefusal` (`core/errors`), `waitRetryAfter` and `RATE_LIMIT_RETRIES` (`core/clock`), and `core/reality`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` as the other drivers use them |
| Schema checks | for a platform that publishes a description of its API (OpenAPI, GraphQL): the validators in `server/test/schemas/<name>.ts` and their entry in `SCHEMAS` (`index.ts`), which the acceptance run then applies to every test. A platform without one types its payloads with its SDK's types instead (Notion) |

## The order

1. **The driver**, `server/src/drivers/<name>/`: its definition in `index.ts` (with `name`,
   `title`, `ids`, `secrets`, `tokenPatterns`, `hosts`), registered in `server/src/drivers/index.ts`.
   Then the fake (`fake/`), its payloads, its routes, its transcript, following `docs/architecture.md`
   3.3. Its handles' schemas say what they are on the channel: `x-channelstack-resource: { id: "id",
   role: "user" | "app" | "resource" }` for the person, the app and the places things happen in.
2. **Generate**: `pnpm spec` and `pnpm sdk`. The SDKs, their channel unions and fixtures, and the
   Rust matcher subjects follow from the routes.
3. **The contract**: `api/<name>.d.ts`, exported from `api/index.d.ts`, and
   `api/examples/<name>.test.ts`. `pnpm api:check` holds them to the generated SDK.
4. **The agents**: a reference agent on the platform's official SDK in `examples/agents/<agent>/`,
   and one with one fault per check, `examples/agents/broken-<name>/`. Both go into
   `scripts/lib/channels.ts` (`HARNESS`), with what of the examples is enabled.
5. **The standard checks**: `<NAME>_CHECKS` and `<name>Checks()` in `integrations/checks/`, and
   `test/acceptance/checks/<name>-checks.test.ts`.
6. **Delivery cases**: `server/test/integration/<name>-delivery.test.ts`, the platform's own
   receiver against the binary (`docs/phases.md`, appendix).
7. **Live mode**: `live/` (client, identity, world, cleanup, maintenance), the definition's `live`
   (credentials, allowlist), the variables in `.github/workflows/live.yml`, and the reference agent's
   start in `scripts/lib/live-agents.ts` (`LIVE_AGENTS`).
8. **Conformance**: a scenario in `scenarios/<name>/`, and its divergences, if any, in
   `conformance/divergences.yaml`.
9. **Docs**: a `## <Title>` section in `docs/reality-matrix.md`, the guide
   `website/docs/platforms/<name>.mdx`, the channel's variables in
   `website/docs/reference/environment-variables.md`, and the rows of `docs/code-map.md`.

A channel that shares a part of the acceptance suite with others is grouped in `scripts/accept.ts`;
otherwise it gets a part of its own, which `.github/workflows/ci.yml`'s matrix lists
(`node scripts/accept.ts --parts`).
