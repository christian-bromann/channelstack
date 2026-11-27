# 0026: Discord, on the Gateway and HTTP interactions

Status: accepted, 2026-11-26, in phase 11.

## Reopening "Channels"

AGENTS.md settled the channels as Slack, GitHub, Linear, Notion, Resend and Google, with Discord
under "After 0.1" in `docs/phases.md`. The maintainer asked for Discord (and Twilio, phase 10), so
the "Channels" row is reopened on their instruction: Discord is channel 8, phase 11.

**Phases 10 and 11 run in parallel**, at the maintainer's request, each in its own pull request.
That overrides AGENTS.md's "one phase at a time" for these two only. Both touch the same shared
files (`docs/phases.md`, `AGENTS.md`, `docs/code-map.md`, `docs/reality-matrix.md`,
`conformance/divergences.yaml`, `scripts/lib/channels.ts`, the driver registry, CI's matrix);
whichever merges second merges `main` in and resolves them.

## What Discord is in channelstack

**A bot in a guild.** People write in channels, threads and DMs. The agent is a bot that hears them
over the **Gateway**, a WebSocket it opens itself (`GET /gateway/bot`, HELLO, IDENTIFY with its token
and intents, heartbeats, READY, then dispatches with sequence numbers, RESUME after a drop), and
answers through **REST v10**. This is how discord.js, discord.py and every other library connect.

**Interactions two ways, as Discord does.** An application with an *interactions endpoint URL*
gets slash commands and component presses there, over HTTP, signed with Ed25519 over the timestamp
and the exact body; the HTTP response is the interaction's response, within 3 seconds, and Discord
never retries. One without gets `INTERACTION_CREATE` over its Gateway connection and answers with a
callback, also within 3 seconds. The fake does both: `CHANNELSTACK_DISCORD_WEBHOOK_URL` is the
interactions endpoint. The reference agent takes them over HTTP (the acceptance run covers it); the
Gateway's are delivery case D7.

**A Gateway dispatch is a delivery** on the one delivery queue, over a `DeliveryTransport` (as
Slack's Socket Mode envelopes are), so a test reads `message.delivery` and `deliveries()` the same
way. The Gateway has no acknowledgement: a dispatch is delivered once written. A dispatch made while
the bot's session can be resumed is kept and replayed after RESUME; a new IDENTIFY starts a new
session and what the old one missed is gone, as in Discord. A dispatch for a bot that hasn't
connected waits up to its 3-second window for a connection, so a test that starts while the agent
is still connecting doesn't lose its first message; the reference agent listens on its port only
once it is ready.

**The `drop_gateway` fault drops the connection just before the session's next dispatch**, so the
check `discord.resume` is deterministic: a bot that resumes gets that dispatch replayed; one that
identifies anew never sees it.

## A person live: a second bot, through the API

Discord has no API that acts as a person. A user token, or a "self-bot" (a person's account driven
by a script, including through Discord's web client), breaks Discord's terms and can get the account
terminated, so channelstack doesn't do either. Live mode exists to check the fake's payloads against
Discord's, and a known difference in them is acceptable where the platform's rules leave no other
way (the maintainer's decision, 2026-11-26).

So a live person is **a second bot**: the bot user of an application of its own, in the sandbox
guild. Its token is `CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN`, which the SDK reads into
`createUser({ token })`; it stays in memory on the server, is never logged, and is checked when the
person is made: it is a bot's, not the agent's own, and that bot is in the guild. The person writes,
replies, edits, deletes, reacts and starts threads through REST v10 with that token, and the test
reads the same as in the fake (`ana.say(...)` is unchanged).

What that leaves different, recorded in `conformance/divergences.yaml` (`shapes/discord`):

- **What a person writes carries `author.bot: true`** (and a bot's null `global_name`). An agent
  that ignores bots, as it should and as `discord.ignores-bots` checks, has to be told which bots are
  people for a live run; the reference agent takes `DISCORD_PEOPLE_BOTS` (bot ids), which the live
  run sets from the people's tokens. The fake doesn't change.
- **No DMs with the app**: Discord lets no bot write to another bot in a DM, so `say({ to })` and
  `openDM` are fake-only.
- **No slash commands or button presses**: Discord makes interactions of people only, and no bot
  can run another application's command or press its button, so `runCommand` and `click` are
  fake-only. Interactions are covered against the fake, and their payloads against
  `discord/discord-api-spec`.
- **A person's id is their bot's**, so `createUser({ id })` and `createUser({ bot })` are fake-only.

The bot makes each session's channels in the sandbox guild, private to their participants and named
with the run's tag, and deletes them when the session closes (taking their messages and threads with
them); `channelstack sweep` deletes what a crashed run left. The bot must therefore hold *Manage
Channels* and *Manage Roles* there. Live mode never relays or synthesizes events to the agent:
Discord delivers them.

## Alternatives

- **REST only, no Gateway** (interactions over HTTP, nothing else): most Discord agents read
  messages, which only the Gateway delivers, so this would test almost nothing they do.
- **A person in Discord's web client, as the browser actor** (as Slack's clicks are, decision
  0015): it would hide the `author.bot` difference and run commands and buttons live, but it
  automates a person's account, which Discord forbids, and could get the sandbox's accounts
  terminated. Built first in this phase, then removed on the maintainer's instruction.
- **A user token:** against Discord's terms; refused.
- **Compressed or ETF Gateway payloads:** the fake speaks JSON without compression, as v10 does
  without `compress`; a client that asks for `zlib-stream` or `etf` is closed with 4012. discord.js
  uses neither unless `zlib-sync` or `erlpack` is installed.

## Proxy mode

`env --proxy` routes `discord.com` and `gateway.discord.gg` to the fake, and REST goes through the
proxy. discord.js's Gateway client (`ws`) doesn't use `HTTPS_PROXY`, so an unmodified discord.js
agent in proxy mode would open its Gateway connection to Discord itself. The fake half of the
differential run therefore runs the Discord agent with the fake's own URLs (the harness's
`unproxied`), and both halves record the dispatches through a tap on discord.js
(`scripts/lib/discord-event-tap.ts`, as Slack's events are tapped, decision 0020): the shapes of
what the Gateway sends are compared, fake against live. The bot's REST calls aren't recorded on
the fake half.
