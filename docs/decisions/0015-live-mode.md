# 0015: Live mode

Status: accepted, phase 5.

Live mode acts on the real platforms and reads the results back. It never relays, forwards or synthesizes events to the agent ([live-mode.md](../live-mode.md)).

## A driver is live when all of its credentials are set

A driver declares the environment variables that make it live (`live.credentials` in its definition) and its allowlist variable. Slack: `CHANNELSTACK_SLACK_APP_ID` and `CHANNELSTACK_SLACK_BOT_TOKEN`, allowlisted by `CHANNELSTACK_LIVE_SLACK_TEAMS`. With all of them set and `CHANNELSTACK_REALITY` not `fake`, its routes act on the real platform.

- **Some set, not all** refuses every route of that driver with `live_misconfigured`, naming what is missing. A typo in a variable name must not run silently fake.
- **`CHANNELSTACK_REALITY=live`** also refuses a person without a token, and a driver without its credentials (`live_misconfigured`).
- **Reality is per driver, not per object.** The implementation plan's rule ("a conversation lives where its app lives") makes every container live once the app is. People are per object: a person without a token can exist, but acting in a live workspace is refused with `fake_actor_in_live_world`.
- **GitHub, Linear and Notion declare their credentials, and their live backends aren't built.** With the credentials set, their routes refuse with `unsupported_in_live` ("live github isn't built yet"), so a nightly run skips their tests instead of running them fake and passing.

Alternative: decide reality in each driver from `process.env`. Rejected by the code map: core decides, drivers don't branch on credentials.

## Core refuses what doesn't work live, from the route's declaration

A route says how it works live (`live` on the route, `x-channelstack-live` in the spec): `{ unsupported: reason }` for "No" and "Not yet" in the matrix; `{ requires: "browser" | "proxy", reason }` for what needs a piece this server doesn't have. On a live driver, `DriverRouter` refuses those with `unsupported_in_live` or `action_requires`, before the handler runs and before anything reaches the platform. The reason comes from the declaration, so the refusal, the matrix and the spec can't drift. Exit check 5.4 reads the matrix's fake-only rows and calls each one on a live server.

The Vitest integration skips a test that hits either refusal, with the reason in the report (`context.skip(note)`, through a refusal hook on the SDK transport that also names the request, so a concurrent test skips only itself). The fake run never meets these refusals, so the test still runs in full on every PR.

**A setup that can't work fails instead: `live_misconfigured`.** Credentials set in part, a token of the wrong kind, `CHANNELSTACK_REALITY=live` with a person who has no token. If those skipped, a nightly run with a broken setup would skip everything and pass. `pnpm live` also fails when a channel whose credentials are set passed no live test, a channel whose live backend isn't built among them: its tests skip, and the job reports that 5.1 isn't met for it.

## One `World` for both: lookups at once, actions and reads awaited

The Slack `World` keeps its lookups of what a session made (people, conversations, the app, the workspace) synchronous, and lets actions and reads return a promise. The fake implements it synchronously (`Immediate<SlackWorld>`), and the live world awaits the Web API. The routes `await` either. That keeps "one action, two backends" (architecture.md 3.3) without the fake becoming async.

The live world mirrors what the session made, so a message's author and conversation resolve without a call. Reads are cached for a second, because matchers poll every 50ms and Slack's read methods allow about one call a second. A write invalidates the cache for its conversation.

## Allowlists hold before anything is done

The live Slack driver checks the bot token once, before its first action: `auth.test`, the workspace must be in `CHANNELSTACK_LIVE_SLACK_TEAMS`, and the token must be a bot token. A definitive refusal is kept, so every later action is refused the same way without asking Slack again; a network error or a rate limit isn't, and the next action asks again. `auth.test` is the only call that can happen before the check, because it is how channelstack learns which workspace a token is for. A person's token is checked when the person is created: a user token, in the app's workspace (`cross_workspace_credential` otherwise). One function makes these checks (`drivers/slack/live/identity.ts`), for the live world and `channelstack doctor` alike.

## Cleanup: a ledger per server, a sweep for crashes

Every live object a session makes goes into the ledger (`core/ledger`). The session closing removes them newest first, and so does the server stopping. Each server writes its own file in `<home>/ledger/<pid>-<time>.json` (0600), so a crash leaves a list behind, and `channelstack sweep` removes it once that server is gone. The ledger names whose credential removes an object (`app`, `user:ANA`), never the credential itself. Entry ids carry the run and the server (a CI re-run keeps its run id), and the sweep matches each entry within its own file.

- **Slack channels are archived.** Slack can't delete a channel outside Enterprise Grid. Every live channel is named `channelstack-run-<run>-<n>[-<name>]`, so names stay unique in a real workspace and the sweep finds what a ledger lost.
- **A DM can't be archived, and other sessions may write in the same one** (a person has one DM with the app). Each message the session writes there is an entry, and cleanup deletes it with the replies under it: people's with their tokens, the agent's with the bot token. Messages by anyone else stay, and so does an agent's answer outside the thread (reference agents answer in the thread, except in group DMs).
- **`channelstack sweep --check --run <id>`** is exit check 5.2: what a run left, from the ledgers and the tags, exit 1 if anything is. An entry it can't look at (no credentials here, a workspace outside the allowlist) counts as left.

## The quiet check refuses live without proxy mode

Live, the agent works on the real platform, and nothing tells channelstack when it is done. A session that acted live gets `action_requires` (proxy mode) from `GET /sessions/{sid}/quiet`, so negative and exact-count matchers skip live instead of passing on an empty event log. Positive matchers (`toHaveReplyFrom`) poll and work. The matrix's fallback (the transcript unchanged for `quietFor`) can come later.

## People's tokens come from the SDK, apps' from the server

`createUser({ name: "Ana" })` reads `CHANNELSTACK_SLACK_USER_ANA_TOKEN` in the SDK when the test leaves `token` out (`x-channelstack-credential` on the field, runtime `credentials` in both SDKs). The app's credentials come from the server's environment. Both stay in memory as `LiveCredential`, which shows `[redacted]` in JSON, strings and `console.log`, and is registered with the redactor. The control API returns empty strings for a live app's tokens.

## A person's message needs Slack's client

Found against the real sandbox on 2026-11-23, in two steps:

1. The sandbox's first person token was issued by the agent's own app, so Ana's messages showed as the app's.
2. With a token from a separate app for the sandbox's people, they are Ana's, but **Slack marks every message posted through its API with the posting app's `bot_id` and `app_id`**, a person's user token included, and `as_user=true` doesn't change that.

The reference agent drops any event with a `bot_id` (Bolt agents commonly do), and so does the standard check "ignores other bots" (`slackChecks()`). So no person's message posted through the API reaches the agent. Only a person typing in Slack's client makes a message without that mark.

Decision (the maintainer's): **live, a Slack person's `say` and `reply` are typed in the client by the browser actor.** Their routes declare `requires: "browser"`, so they report `action_requires` until the browser actor exists, and Vitest skips them with the reason. The person's user token stays the credential for everything else: creating channels, invites, kicks, DMs, reactions, edits, deletes and reads. Whether an edit through the API carries the same mark is unverified.

Alternative: keep posting through the API and make the reference agent accept a message with the people app's bot. Rejected: it weakens the "ignores other bots" check for every agent, and a real agent wouldn't do it.

What a session writes in a DM is deleted when it closes, with the replies under it (ledger kind `message`). The browser actor will record what it types there. A Slack app configuration token doesn't help either: it only calls the App Manifest APIs.

## The Web API is called with `fetch`, form-encoded

There is no Slack SDK in the server: it needs a dozen methods, and `@slack/web-api` brings axios and its own retry logic into the binary. Parameters go form-encoded, as Slack's own SDK sends them. Read methods ignore a JSON body: the first live run got `user_not_found` from `users.info`. A 429 waits for `Retry-After` on the injected timers. A refusal is a `SlackRefusal` with Slack's code and the method, never the token or the rest of Slack's answer. The base URL can be changed only through `createApp`, for the unit tests' stand-in, never from the environment, so a token can't be sent elsewhere.
