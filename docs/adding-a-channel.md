# Adding a channel

A channel is its driver folder, its examples, its agents and its docs. Everything else (the
channel list, the SDKs' unions and fixtures, the Vitest and pytest fixtures, the inspection routes,
the acceptance parts) comes from those. `pnpm check:channels` names what is still missing, so the
order below is also the order its failures come in.

The kit the driver is built on, all in `server/src/core/`:

| What | Where |
|---|---|
| Ids in the platform's format | `idFormats("resend", { … })` in the driver's `ids.ts`, on the definition as `ids`; shapes from `core/ids` (`uuid`, `numeric`) |
| Tokens and signing secrets | the driver's `secrets.ts` (`SecretFormat`s, helpers from `core/secrets`), named by the definition's `secrets`; their shapes as `tokenPatterns`, and tokens that aren't among the secrets (real ones the fake never makes, ones it makes per request, as Google's access tokens) as `liveTokens` |
| Webhooks | the driver's `signing.ts` on `core/signing/hmac.ts`; `deliveryKit(context, { driver, timeoutMs, retry: fixedRetries([...]), stamp, sign, secret })` sends, resends and lists them. A forgery only the platform makes (a Pub/Sub token for another audience) is `resend(…, { forge })`: handed the secret and time the other options chose, so it combines with them, and offered through `registerInspectionRoutes`'s `resend.options` (`wrongAudience`) |
| Deliveries and calls routes | `registerInspectionRoutes(router, { title, delivery, filters, redeliver, resend, calls, … })` |
| A REST platform's fake API | `restApi(context, { driver, authorize, refusal, invalidJson, notFound })` from `core/fake/endpoint.ts`: each endpoint authorized, its JSON body parsed, a refusal answered in the platform's shape, the call on record. An endpoint that takes a form (an OAuth token request) says so: `endpoint(…, { form: true })`; a 204 answers no body. For routes that answer Hono responses and check their own credentials (GitHub), `wrapRest(context, { driver, refusal, decorate, internal }, router, { sessions, recorded })` answers refusals in the platform's shape and puts each call on record; the routes parse bodies with `bodyOf` |
| SDKs that keep their paths at the root | the definition's `rootPaths` (`/gmail/v1/`): served at the server's root too, without portless, for an SDK that rebuilds each URL against its base and drops the base's path (`googleapis`) |
| An email channel | `core/email`: the store (`EmailStore`: the agent's mailbox, people, emails, conversations), the control routes (`registerEmailRoutes` over an `EmailWorld`: the fixture, people who send, reply and read their inbox, the threads), MIME (`composeMime`, `parseMime`, `mimeHeaders`, `withHeaders`), and `replyOf`, `emailAuthor`, `threadOf`, `threadTranscript`. Resend and Google are built on it; their reference agents share `examples/agents/shared/email.ts` |
| Apps | `core/apps` ([decision 0027](decisions/0027-multiple-apps.md)): `AppRoster` holds the built-in `my-agent` and the apps tests make by name (`make`, `named`, `all`, `extra`), with the name rules and the limit of 10; `checkNameFree` keeps a person's and an app's names apart in a session; the context's `apps` gives each app's webhook URL (`CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL`, `appWebhookVariable`), secrets (`secret(app, name)`, kept by `core/secrets`) and ids (`ids(app)`, from `IdGenerator.named`). `deliveryKit`'s `send({ app })` signs with that app's secret |
| The loop guard | `core/loops`, the context's `loops`: the driver's one message path tells it who wrote where (`wrote`), and asks before delivering an event an app's message caused (`allows`) |
| The dev tools | `DevAdapter` from `core/dev`, as the definition's `dev`: the CLI, `channelstack mcp` and the UI act on the channel through it ([decision 0028](decisions/0028-dev-tools-on-every-channel.md)) |
| Route helpers | `refTo`, `pathParam`, `Awaitable`, `DeliveryView` from `core/router`; `iso` from `core/clock` |
| Live clients | `LivePlatformRefusal` (`core/errors`), `waitRetryAfter` and `RATE_LIMIT_RETRIES` (`core/clock`), and `core/reality`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` as the other drivers use them |
| Schema checks | for a platform that publishes a description of its API (OpenAPI, GraphQL): the validators in `server/test/schemas/<name>.ts` and their entry in `SCHEMAS` (`index.ts`), which the acceptance run then applies to every test. A platform without one types its payloads with its SDK's types instead (Notion) |

## The order

1. **The driver**, `server/src/drivers/<name>/`: its definition in `index.ts` (with `name`,
   `title`, `ids`, `secrets`, `tokenPatterns`, `hosts`), registered in `server/src/drivers/index.ts`.
   Then the fake (`fake/`), its payloads, its routes, its transcript, following `docs/architecture.md`
   3.3. Its handles' schemas say what they are on the channel: `x-channelstack-resource: { id: "id",
   role: "user" | "app" | "resource" }` for the person, the app and the places things happen in.
   **Apps:** `POST` and `GET /apps` (`createApp({ name, … })` and `apps()` on the fixture), an app
   handle with the acting methods a person has, refused for `my-agent`, `env(app)` on the definition
   (another app's lines under the built-in app's keys), every delivery to the app it went to, and the
   platform's bot-to-bot rules, tested in `server/src/drivers/<name>/<name>-apps.test.ts`.
2. **Generate**: `pnpm spec` and `pnpm sdk`. The SDKs, their channel unions and fixtures, and the
   Rust matcher subjects follow from the routes.
3. **The examples**: `test/acceptance/examples/<name>.test.ts`, written against the generated SDK.
   `pnpm typecheck` holds them to it, and the acceptance run plays them against the agents. They
   include a `describe("several apps")` block, played against the reference agent running twice,
   as `my-agent` and as `coder`.
4. **The agents**: a reference agent on the platform's official SDK in `examples/agents/<agent>/`,
   and one with one fault per check, `examples/agents/broken-<name>/`. Both go into
   `scripts/lib/channels.ts` (`HARNESS`), with what of the examples is enabled (`"several apps > "`
   among them). The reference agent takes its app's name from `AGENT_NAME`, as the stack starts it a
   second time with `channelstack env --app coder --channel <name>`.
5. **The standard checks**: `<NAME>_CHECKS` and `<name>Checks()` in `integrations/checks/`, and
   `test/acceptance/checks/<name>-checks.test.ts`, with `<name>.no-reply-loop` among the checks
   (and its fault in the broken agent: answering every app), and
   `test/acceptance/checks/<name>-checks-coder.test.ts`, the checks against `coder`, in the
   channel's `HARNESS` suites.
6. **Delivery cases**: `server/test/integration/<name>-delivery.test.ts`, the platform's own
   receiver against the binary (`docs/phases.md`, appendix).
7. **Live mode**: `live/` (client, identity, world, cleanup, maintenance), the definition's `live`
   (credentials, allowlist), the variables in `.github/workflows/live.yml`, and the reference agent's
   start in `scripts/lib/live-agents.ts` (`LIVE_AGENTS`).
8. **Conformance**: a scenario in `scenarios/<name>/`, and its divergences, if any, in
   `conformance/divergences.yaml`.
9. **The dev tools**: the channel's dev adapter in `server/src/drivers/<name>/dev.ts` (`core/dev`),
   on the definition as `dev`: what a place is, its list route (add `GET /users` and one for its
   places if the channel has none), and how a person says, replies and reacts there. Its actions
   come from its routes with `pnpm sdk`. Add its case to `server/src/cli/dev.test.ts` (`CASES`).
10. **Docs**: a `## <Title>` section in `docs/reality-matrix.md`, the guide
   `website/docs/platforms/<name>.mdx`, the channel's variables in
   `website/docs/reference/environment-variables.md`, and the rows of `docs/code-map.md`.

A channel that shares a part of the acceptance suite with others is grouped in `scripts/accept.ts`;
otherwise it gets a part of its own, which `.github/workflows/ci.yml`'s matrix lists
(`node scripts/accept.ts --parts`).
