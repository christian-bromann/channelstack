# Phase 11 closed

Pull request: [christian-bromann/channelstack#103](https://github.com/christian-bromann/channelstack/pull/103), squash-merged on 2026-11-27 and tagged `phase-11-done`. Built in parallel with phase 10 (Twilio), at the maintainer's request ([decision 0026](../../docs/decisions/0026-discord.md)).

## What was built

- **Discord**, channel 8: a bot in a guild.
  - The Gateway v10: HELLO, IDENTIFY, READY and GUILD_CREATE, then dispatches in sequence, with RESUME and its replay, INVALID_SESSION, Discord's close codes, and its intents, the privileged ones included.
  - REST v10, as discord.js calls it, with Discord's error shape and codes, its permissions, its rate limits (`X-RateLimit-*` and a 429 with `retry_after`) and its 2000-character limit. Answers and dispatches are held to `discord/discord-api-spec`, pinned by commit (11.2).
  - HTTP interactions signed with Ed25519 and checked with `verifyKey`, the 3-second window, every response type, followups and `@original`, and Discord's endpoint check (`verifyEndpoint`).
  - Snowflakes for every id, and bot tokens in Discord's form.
  - Discord's routes in the generated SDKs, and its examples (11.1). The `discord-node` reference agent and `broken-discord`, `discordChecks()` (11.4), Discord in `shared.test.ts` (11.5), the delivery cases D1–D8 (11.3).
  - Live (11.7): the agent's bot acts and reads back in an allowlisted guild. A person is a second application's bot there (`CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN`): Discord has no API that acts as a person, and automating a person's account breaks its terms. Each session's channels are tagged with the run, on the ledger, and deleted when it closes; the sweep removes what a crashed run left.
- **Shared code** (11.6): `core/socket`, the agent's open connections and waiting for one, with Slack's Socket Mode moved onto it; a socket's close code; `DeliveryRecord.sent`; one OpenAPI schema check for Resend and Discord; `personVariables` in `core/maintenance`, every channel's people's credentials for `doctor` and `sweep`; snowflakes as ids and `publicKey` as setup in `conformance/lib.ts`.
- **What adding Discord showed the other channels needed** (d5526f8), from a review of the duplication it added: every live world checks its credentials with `checkOnce` (`core/reality`), which asks again after a network error, a 5xx or a 429 (`LivePlatformRefusal.httpStatus`); Discord, Resend and Google had kept any failure for the life of the server. `personWithoutToken` is the one refusal of a person without a token in a strict live run; `channelstack env` hides a live channel in `app.ts`; Discord's live channels are a registry `Collection`. Three more (the live REST retry loop, a fault list, the delivery tests' receiver) are left for a `fix/` pull request, as they change only channels already merged.
- **Verified against real Discord** on 2026-11-27 (11.7, 11.8), with the agent's bot and two people's bots in a sandbox guild. The live examples pass with nothing left behind. The differential run of `scenarios/discord/mention.yaml` finds no difference; the live run also found:
  - live mode named the app by its bot's real name, not `my-agent`; fixed, as Slack's live mode does it;
  - four documented fields the fake didn't send (READY's `flags_new`, the guild's `hub_type` and `premium_progress_bar_enabled_user_updated_at`, a mention's `member`); added;
  - Discord's snowflakes, which the comparison didn't treat as ids; now it does.
  - What remains is recorded in `divergences.yaml`: `author.bot` on what a person's bot writes, nullable fields the sandbox fills (avatars, the guild's icon and system channel), and Gateway fields no pinned schema declares.

## The gate

`pnpm verify:phase 11` passes in CI on the last head, with each acceptance part three times.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 15: 2 blocking, 6 should-fix, 7 nits | All fixed (9158bf6) |
| 2 | changes required | 4: 1 should-fix, 3 nits | All fixed (dbc9eda, 6a2592c) |
| 3 | changes required | 5: 1 should-fix, 4 nits | All fixed (d276860) |
| 4 | changes required | 7, on a live person as a second bot: 1 blocking, 4 should-fix, 2 nits | All fixed (ad27882) |
| 5 | changes required | 3: 1 should-fix, 2 nits | All fixed (0868e08) |
| 6 | changes required | 4, on the live run's fixes and the shared live code: 1 blocking (the PR's list of shared files), 2 should-fix, 1 nit | All fixed (3120931, the PR body) |
| 7 | changes required | 2: 1 should-fix (the PR body from before #104), 1 nit (this note) | All fixed (the PR body, this note) |

Every thread is resolved. After three rounds no blocking finding was open; round 4 reviewed the change of a live person from the browser actor to a second bot, and round 5 its fixes. Rounds 6 and 7, at the maintainer's request, reviewed the live run's fixes and the shared live code; round 7 found nothing blocking. The phase closes on the round 7 fixes, per the maintainer's rule.

## For the maintainer

- The sandbox guild has the agent's bot (`CHANNELSTACK_DISCORD_BOT_TOKEN`) and two people's bots, Ana and Ben. Their tokens are in `live.env` and in the `live` environment for the nightly job.
- The agent's app has no Interactions Endpoint URL, so interactions reach it over the Gateway and `CHANNELSTACK_DISCORD_RELAY_URL` stays unset.
- Phase 10 (Twilio, #102) merges `origin/main` in and resolves the files both phases touched.
