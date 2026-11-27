# Phase 11 plan: Discord

Discord as channel 8 (Twilio is channel 7, phase 10, built at the same time in its own pull
request: [decision 0026](../../docs/decisions/0026-discord.md)). The agent is a bot in a guild. People
write in channels, threads and DMs; the bot hears them over the **Gateway** (a WebSocket it opens
itself) and answers through **REST v10**. Slash commands and buttons reach it as interactions:
over HTTP, signed with Ed25519, when the app has an interactions endpoint, otherwise over the
Gateway. The reference agent is on **discord.js**.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 11.1 Every fake Discord example passes | `api/examples/discord.test.ts` (all but "live mode"), against `examples/agents/discord-node` | `api/discord.d.ts`, `server/src/drivers/discord/` (fake, routes, payloads, transcript), `scripts/lib/channels.ts` |
| 11.2 Discord matches its description | `server/src/drivers/discord/discord.test.ts`, and the acceptance run through `SCHEMAS`: every REST answer, and every Gateway dispatch whose object the description has (a message, a channel, an interaction), against the pinned `discord-api-spec` | `server/test/schemas/discord.ts`, `server/test/schemas/discord-openapi.json`, `scripts/pinned-schema.ts` (`pnpm discord:schema`) |
| 11.3 The Gateway and interactions work with discord.js and an Ed25519 verify | `server/test/integration/discord-delivery.test.ts`: cases D1–D8 of the appendix against the binary | `drivers/discord/fake/gateway.ts`, `drivers/discord/signing.ts`, `core/socket` |
| 11.4 Standard checks | `test/acceptance/checks/discord-checks.test.ts`, `test/acceptance/checks-broken.test.ts` | `integrations/checks/index.ts` (`DISCORD_CHECKS`, `discordChecks()`), `examples/agents/broken-discord` |
| 11.5 All channels in one run | `api/examples/shared.test.ts` | the harness table only |
| 11.6 The kit held | `pnpm check:channels`; the PR lists every file it changed outside the Discord driver, contract, agents, scenarios and docs | — |
| 11.7 Discord live | the "live mode" block of `api/examples/discord.test.ts` against the sandbox guild; `drivers/discord/live/live.test.ts` against a stub; the allowlist holds, and the sweep finds nothing left | `drivers/discord/live/` (client, identity, world, cleanup, maintenance, ui), `server/test/discord-live-stub.ts`, `scripts/lib/live-agents.ts`, `.github/workflows/live.yml` |
| 11.8 Conformance | `scenarios/discord/mention.yaml` in the differential run | `conformance/divergences.yaml` (`shapes/discord`, if any) |

## What the fake is

- **Host:** `discord.localhost`, the REST API at `/api/v10/…` (and `/api/v9`, which some clients
  still use: the same routes), the Gateway at `/gateway`. In proxy mode `discord.com` (and the
  Gateway's `gateway.discord.gg`).
- **The world:** one guild, `Acme`, with the agent's app installed as a bot (`my-agent`), its
  managed role, and an `@everyone` role. People are guild members, created per test. A channel is
  created per test; `participants` are the members who can see it (a permission overwrite each, as a
  private channel is made in Discord), so the bot hears a channel only when it is a participant, as
  Slack's app does. `readOnly` makes a channel people read and only admins write in.
- **Gateway** (v10, JSON, no compression): `GET /gateway/bot` gives the URL; HELLO with the
  heartbeat interval; IDENTIFY with the bot token, intents and the shard (one); READY
  (`session_id`, `resume_gateway_url`, the user, the application, the guild as unavailable), then
  GUILD_CREATE; heartbeats and their ACKs; RESUME replays what was dispatched after the client's
  sequence number, and INVALID_SESSION (`d: false`) for a session it doesn't know. Close codes:
  4004 a bad token, 4013 invalid intents, 4014 a privileged intent the app doesn't have, 4002 a
  payload that isn't JSON, 4003 a payload before IDENTIFY. Each dispatch has the next `s`.
- **Dispatches**, each a delivery a test can read: `MESSAGE_CREATE`, `MESSAGE_UPDATE`,
  `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `CHANNEL_CREATE`,
  `CHANNEL_UPDATE`, `THREAD_CREATE`, `GUILD_CREATE`, `INTERACTION_CREATE` (without an interactions
  endpoint). (`POST /channels/{id}/typing` is taken and shows nothing: no `TYPING_START`.) Each only with its intent (`GUILD_MESSAGES`, `DIRECT_MESSAGES`, `GUILD_MESSAGE_REACTIONS`,
  …), and only to a bot that can see the channel.
- **`MESSAGE_CONTENT`:** without the intent, a guild message's `content`, `embeds`, `attachments`
  and `components` arrive empty, except the bot's own, a DM, and one that mentions the bot.
- **REST v10**, the routes discord.js calls: `GET /gateway/bot`; `/users/@me`, `/users/{id}`,
  `POST /users/@me/channels` (a DM); `GET /channels/{id}`; messages (`GET` one and a list,
  `POST` with `message_reference`, embeds and components, `PATCH`, `DELETE`); reactions (`PUT` and
  `DELETE …/@me`, `GET` who reacted); `POST /channels/{id}/typing`; threads
  (`POST …/messages/{id}/threads`, `POST /channels/{id}/threads`, `PUT/DELETE
  /channels/{id}/thread-members/@me`); `GET /guilds/{id}`, `/guilds/{id}/channels`,
  `/guilds/{id}/members/{user}`; application commands (global and guild: list, create, bulk
  overwrite); `POST /interactions/{id}/{token}/callback`; followups
  (`POST /webhooks/{app}/{token}`, `GET/PATCH/DELETE /webhooks/{app}/{token}/messages/@original`).
- **Discord's refusals:** `{ code, message, errors? }` with Discord's JSON error codes: 0 for a 401
  and a 404 route, 10003 Unknown Channel, 10008 Unknown Message, 10062 Unknown Interaction, 50001
  Missing Access, 50013 Missing Permissions, 50005 another user's message, 50006 an empty message,
  50035 Invalid Form Body (with `errors`, as the 2000-character limit is reported), 40060 an
  interaction already acknowledged.
- **Permissions** from the roles and the channel's overwrites, as Discord computes them
  (`VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`, `CREATE_PUBLIC_THREADS`,
  `ADD_REACTIONS`, `READ_MESSAGE_HISTORY`, `MANAGE_MESSAGES`, `ADMINISTRATOR`).
- **Rate limits** per route, with the `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-After`,
  `-Bucket` headers, and a 429 with `retry_after` and `Retry-After` past them: 5 messages per 5 s
  per channel, a reaction per 250 ms, 50 a second for the rest of a route and its channel (no global
  limit). A test's `rate_limit`
  fault refuses the next calls of a route the same way.
- **Interactions:** a person's slash command (one the agent registered) and button click become an
  interaction with a token. Over HTTP, signed `X-Signature-Ed25519` over the timestamp and the exact
  body, with the install's key, whose public half is the app's; the response body is the
  interaction's response, within 3 seconds, never retried. Over the Gateway, the callback must come
  within 3 seconds. Late, a person sees "This interaction failed". Responses: 4 (a message), 5 (a
  deferred one, shown as "my-agent is thinking…" until the original is edited), 6, 7 (the
  component's message updated), ephemeral with flag 64. A second response is 40060. Followups and
  the original for 15 minutes. Discord's check of a new interactions endpoint: a PING that must be
  answered with a PONG, and one with a bad signature that must be refused (`verifyEndpoint()`).
- **Ids** are snowflakes (Discord's epoch, the time in the high bits); a bot token is
  `<the bot's id in base64>.<6>.<38>`, so the bot's id is in its token, as in Discord's.
- **Transcripts:** a message, then the replies to it (Discord's replies and the thread started from
  it) at depth 1; embeds' titles and descriptions, buttons as controls; an ephemeral response only
  for its person; edits applied, deletes removed.

## Contract (`api/discord.d.ts`)

`DiscordFixture` (`app`, `apiUrl`, `guild`, `gatewayConnections`, `createUser`, `createChannel`,
`deliveries`, `fault`, `verifyEndpoint`, and the calls); `DiscordUser` (`say` in a channel or
thread or `{ to }` a DM, `reply` to a message, `edit`, `delete`, `react`, `unreact`,
`startThread`, `runCommand`, `click`, `invite`, `openDM`, `ephemeral`); `DiscordApp`;
`DiscordChannel`, a channel, a DM or a thread (`HasTranscript`, `messages`, `waitForMessage`, `threads`);
`DiscordMessage` (`replies`, `waitForReply`, `latestReply`, `reactions`, `refresh`, `thread`,
`delivery`, `deliveries`); `DiscordDelivery` (`resend` with `badSignature` for an interaction
over HTTP, as `verifyKey` doesn't check a timestamp's age; `redeliver`, a dispatch again).

## Reuse

| Concern | From |
|---|---|
| Driver definition, ids, secrets, token shapes | `DriverDefinition`, `idFormats` and `monotonicMicros` (`core/ids`), `SecretFormat` (`core/secrets`) |
| Deliveries: sending, resending, listing | `deliveryKit` (`core/delivery/kit.ts`); a Gateway dispatch is a delivery over a `DeliveryTransport`, as Socket Mode's |
| WebSockets | `FakeBackend.socket`, `SocketSession`, `app.socket` and `serve.ts`'s upgrade, as Slack's Socket Mode; waiting for the agent's connection moves into core (`core/socket`), and Socket Mode uses it too |
| The REST API | `restApi` (`core/fake/endpoint.ts`) |
| Inspection routes | `registerInspectionRoutes` (`core/router/inspection.ts`) |
| Mentions | `richTextPieces` (`core/rich-text`) |
| Transcripts and calls | `transcriptSchema`, `principalSchema`, `apiCallSchema`, `transcriptText` (`core/router/inspect.ts`) |
| The quiet detector | `openWork` (a deferred response not yet edited), `expectMore` (a 429's retry) |
| Live clients | `LivePlatformRefusal` (`core/errors`), `waitRetryAfter`, `RATE_LIMIT_RETRIES` (`core/clock`), `core/reality`, `core/people`, `core/ledger`, `core/safety`, `core/maintenance` |
| Schema checks | the `SCHEMAS` registry; the OpenAPI validator Resend's check uses, shared rather than copied |
| The pinned description | `scripts/pinned-schema.ts` |

New, with why nothing existing fits:
- `server/src/drivers/discord/`: the driver, the only place Discord's rules live.
- `server/src/core/socket/`: the agent's open connections and waiting for one, which Slack's Socket
  Mode had inline and Discord's Gateway needs too.
- `server/test/schemas/discord.ts`: Discord's OpenAPI document as checks, on the shared validator.

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `discord.js` (dev) | 14.28.1 | The reference agent and the D1–D8 receiver: the Gateway client, its RESUME, REST with its rate-limit handling | Apache-2.0 | Released 2026-11-03 |
| `discord-interactions` (dev) | 4.4.0 | Discord's own `verifyKey`, the Ed25519 receiver of the delivery cases and the reference agent | MIT | Discord's package; stable, last released 2025-10-09 |
| Discord's OpenAPI description (vendored) | `discord/discord-api-spec` at `3a21a01249a763cd47f1dfec3da91c5ba71bb974` (2026-11-06) | Discord's own description of its API, for 11.2 | MIT | — |

The fake signs with Node's built-in Ed25519 (`node:crypto`), which Bun has too: no dependency.

## Decisions

- **Discord reopens the settled "Channels" row** on the maintainer's instruction, and phases 10 and
  11 run in parallel at the maintainer's request, overriding "one phase at a time" for these two
  (decision 0026).
- **Interactions over HTTP when the app has an endpoint.** As Discord does: an app with an
  interactions endpoint URL (`CHANNELSTACK_DISCORD_WEBHOOK_URL`) gets them there, signed; one
  without gets `INTERACTION_CREATE` over its Gateway connection. The reference agent takes them over
  HTTP, which the acceptance run covers; the Gateway's are delivery case D7.
- **A person live is a second bot, through the API.** Discord has no API that acts as a person,
  and a user token or a scripted account (also through the web client) breaks Discord's terms. A
  browser actor in `discord.com/app` was built first, then removed on the maintainer's decision:
  live mode checks the fake's payloads, and a recorded difference (`author.bot`) is acceptable
  where automating an account isn't. A person is a second application's bot
  (`CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN`); DMs with the app, commands and buttons are fake-only,
  since no bot can do them (decision 0026).
- **A dispatch is never lost to a drop the agent resumes from:** while the agent's session can be
  resumed, the fake keeps what it dispatched, as Discord does, and replays it after RESUME. A new
  IDENTIFY starts a new session, and what the old one missed is gone, as in Discord. A bot that was
  never connected misses what happens; the reference agent listens on its port only once it is
  ready.

## Docs to update

`AGENTS.md` (the Channels and Addresses rows), `docs/phases.md` (phase 11, Discord out of "After
0.1"), `docs/decisions/0026-discord.md`, `docs/code-map.md` (rows for the driver and `core/socket`),
`docs/reality-matrix.md` (`## Discord`), `docs/live-mode.md` (credentials table),
`docs/devx.md` tables, `docs/architecture.md` (id table), `docs/adding-a-channel.md` (the socket
helper), the website's platform page and the environment-variable reference, the API reference
(generated), README, `index.html`, the skill, CONTRIBUTING.md and the PR-title check's scopes
(`discord`).

## Appendix: delivery cases D1–D8

| Id | The receiver… |
|---|---|
| D1 | discord.js, with the fake as its REST API, finds the Gateway at `/gateway/bot`, identifies with its token and intents, and becomes ready with the guild |
| D2 | A person's message reaches discord.js as `messageCreate`, its content there with `MESSAGE_CONTENT` (without the intent it is empty unless it mentions the bot: a unit test, as two connections with one token would be two sessions) |
| D3 | A dropped connection is resumed: discord.js sends RESUME with its session and sequence, and gets what was dispatched while it was away, once |
| D4 | A bad token is closed with 4004; a privileged intent the app doesn't have with 4014 |
| D5 | `discord-interactions`'s `verifyKey` accepts an interaction signed with the install's key over the sent bytes, against the app's public key |
| D6 | A re-serialized body, or one signed with another key, is rejected (`verifyKey` doesn't check the timestamp's age) |
| D7 | Without an interactions endpoint, a slash command reaches discord.js as `interactionCreate`, and its `reply` within 3 s is the response; one after 3 s is refused with 10062 |
| D8 | Discord's endpoint check: a PING is answered with a PONG, and a PING with a bad signature is refused with 401 |
