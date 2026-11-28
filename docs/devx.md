# channelstack: interface and developer experience (draft)

> Status: draft v2, 2026-11-19. Nothing is built.
> Decided: `slack.localhost`-style names · one workspace per service · Slack, GitHub, Linear, Notion, email (Resend and Google, [decision 0021](decisions/0021-email-channels.md)) and Discord ([decision 0026](decisions/0026-discord.md)); no Teams for now · in-memory state · integrate into existing test frameworks, no separate test package · extend the test framework's `expect` · no model mocking · MCP plus an attach CLI.
> Also decided: tests use an actor-first API (`ana.say("…", { channel })`). The UI is functional, not a faithful copy of each product ([section 7](#7-the-ui-is-functional-not-faithful)).
> How it's built (server, protocol, SDK generation, live verification) is in [implementation-plan.md](implementation-plan.md); its section 1.1 lists the decisions both documents share. The architecture in short: [architecture.md](architecture.md).

## 1. Core idea

**channelstack is a server.** You start it once and it serves fake channels at stable local HTTPS addresses through [portless](https://github.com/vercel-labs/portless). It also serves a browser UI where you use those channels as a person would. Your agent doesn't know it isn't talking to the real service.

channelstack never wraps or starts your agent. You run the agent as usual and point it at channelstack with an env var per channel.

```
https://channelstack.localhost      UI: channel views, inspector, chaos controls; control API at /_channelstack
https://slack.localhost        Slack Web API, Socket Mode (wss); sends Events API + interactivity
https://github.localhost       GitHub REST + GraphQL; sends App webhooks
https://linear.localhost       Linear GraphQL; sends webhooks + Agent Session events
https://notion.localhost       Notion API; sends integration webhooks (comments, page changes)

https://my-agent.localhost     your agent, under its own portless name, so channelstack can deliver to it
```

Both sides have stable names, so there's no ngrok, no real workspace, no app install and no app review. The URLs channelstack delivers events to never change between restarts.

The names don't collide with emulate: its portless mode uses `*.emulate.localhost`.

### Scope

- **Channels:** Slack, GitHub, Linear, Notion, email (Resend and Google (Gmail), [decision 0021](decisions/0021-email-channels.md)), and Discord ([decision 0026](decisions/0026-discord.md)). No Teams for now.
- **One workspace or org per channel:** one Slack workspace, one GitHub org, one Linear workspace, one Notion workspace. Multi-workspace installs are out of scope until a real test case needs them.
- **State lives in memory.** Restarting the server gives a fresh world.
- **No model mocking.** channelstack fakes the channel, not the LLM. Use your framework's own fake model, or a real one (see [section 6](#6-the-model-is-yours)).
- **Fake by default, real with credentials.** The same test runs against the fakes on every PR and against real sandbox workspaces nightly (see [section 10](#10-live-mode-the-same-tests-against-the-real-platforms)).
- **One shared world, many scopes.** The agent is configured once, so all tests share one workspace per channel. Each test runs in its own session: it owns what it creates, sees only the deliveries its own conversations caused, and is cleaned up at the end. The CLI and UI share a long-lived `dev` session.

### Where the fakes come from

channelstack is an independent project: the fake platforms are channelstack's own implementation, not layered on emulate or another emulator, and no emulator code is copied. Ordinary libraries are used wherever they make sense. Each fake follows the platform's own docs, schemas (GitHub's REST description and webhook schemas, Linear's GraphQL schema) and recorded traffic, and the nightly run against the real platforms keeps it honest.

| Channel | What the fake covers in v0.1 |
|---|---|
| Slack | Conversations, messages, threads, reactions, Block Kit interactivity, modals, slash commands, streams, the agent split view and Stop, Socket Mode, signed delivery with retries |
| GitHub | Repos with an in-memory git store, issues, PRs, reviews, check runs, App installations, signed webhooks with GUIDs, the App delivery log and redelivery |
| Linear | Teams, issues, comments, delegation, agent sessions and activities, the stop signal, signed webhooks |
| Notion | Pages, blocks, databases, comments and discussions, connections, signed integration webhooks |
| Resend | Email to and from the agent's team: sending, the receiving API, Svix-signed webhooks, Resend's test addresses ([decision 0021](decisions/0021-email-channels.md)) |
| Google | A Gmail mailbox: messages, threads, labels, history and watch, Google's token endpoint, Pub/Sub pushes with OIDC tokens, one push a second ([decision 0022](decisions/0022-gmail-push-rate.md)) |
| Discord | A guild: the Gateway (intents, RESUME), REST v10, threads, reactions, slash commands and buttons as interactions over HTTP (Ed25519) or the Gateway, permissions, rate limits ([decision 0026](decisions/0026-discord.md)) |

## 2. First run

```bash
npm i -D channelstack
CHANNELSTACK_SLACK_WEBHOOK_URL=https://my-agent.localhost/slack/events \
  npx channelstack        # first run: starts the portless proxy and trusts its CA
```

```
channelstack 0.1 · in-memory

  Control  https://channelstack.localhost/_channelstack
  echo     https://echo.localhost
  slack    https://slack.localhost
  github   https://github.localhost
  linear   https://linear.localhost
  notion   https://notion.localhost
  UI       https://channelstack.localhost/…   (a one-time login link)

  `channelstack env` prints tokens and URLs as .env lines
```

`CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` tells each fake where your agent takes its events ([section 3](#3-the-agents-app-built-in-no-config-file)).

Point the agent at it, using only options the SDKs already have. When the variable is unset, the agent talks to the real service, so production code is unchanged.

| Channel | SDK option | Env from `channelstack env` |
|---|---|---|
| Slack (Bolt JS) | `clientOptions: { slackApiUrl }` | `SLACK_API_URL=https://slack.localhost/api/` |
| Slack (Python) | `WebClient(base_url=...)` | the same |
| GitHub (Octokit, Probot) | `baseUrl` | `GITHUB_API_URL=https://github.localhost`, with `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` (a PEM in one line), `GITHUB_WEBHOOK_SECRET`, `GITHUB_INSTALLATION_ID` |
| Linear (`@linear/sdk`) | `apiUrl` | `LINEAR_API_URL=https://linear.localhost/graphql` |
| Notion (`@notionhq/client`) | `baseUrl` | `NOTION_BASE_URL=https://notion.localhost` |
| Resend (`resend`) | the environment | `RESEND_BASE_URL=https://resend.localhost` |
| Google (`googleapis`, `google-auth-library`) | `rootUrl` per API; `endpoints` | `GOOGLE_API_URL=https://google.localhost/`, `GOOGLE_TOKEN_URL`, `GOOGLE_CERTS_URL` |
| Discord (discord.js) | `rest: { api }`; the Gateway from `GET /gateway/bot` | `DISCORD_API_URL=https://discord.localhost/api`, with `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_GUILD_ID` |
| Chat SDK, Mastra, Flue | the adapter's API URL option | the same variables |

```bash
npx channelstack env >> .env.local
portless run my-agent pnpm dev           # → https://my-agent.localhost
```

Tokens and signing secrets are random, generated once per install and kept in `~/.channelstack/secrets.json` (mode 0600). They stay the same across restarts, so `.env.local` never goes stale, and `channelstack secrets rotate` replaces them. Socket Mode apps get `wss://slack.localhost/link` from `apps.connections.open` and need no public URL at all.

## 3. The agent's app: built in, no config file

There is no config file. Each fake comes with your agent's app already installed, named `my-agent`, with what a typical agent has:

| Channel | The built-in app |
|---|---|
| Slack | A bot with the scopes a conversational agent uses (`app_mentions:read`, `channels:history`, `chat:write`, `im:history`, `reactions:write`, `assistant:write`, …) and the bot events it subscribes to (`app_mention`, `message.*`, `reaction_added`, `member_joined_channel`, `app_uninstalled`, `agent_session_stopped`, `assistant_thread_started`, …). HTTP delivery or Socket Mode |
| GitHub | The App `my-agent` (its bot is `my-agent[bot]`), with write access to issues, pull requests, contents, checks and statuses, subscribed to issue, comment, pull request, review, push and check run events |
| Linear | An agent app, subscribed to `AgentSessionEvent`, `Issue` and `Comment` webhooks |
| Notion | An integration with every capability, subscribed to `page.*` and `comment.*` events |
| Resend | A team with one verified domain (`acme.example`) that sends and receives, its address `my-agent@acme.example`, its webhook subscribed to every `email.*` event |
| Google | A mailbox, `my-agent@acme.example`, with an OAuth client and its refresh token, and a Pub/Sub topic its watch pushes to |
| Discord | A bot, `my-agent`, in the guild `Acme`, with the privileged intents `GUILD_MEMBERS` and `MESSAGE_CONTENT` switched on, and the permissions a conversational bot's invite asks for. Its interactions endpoint is `CHANNELSTACK_DISCORD_WEBHOOK_URL`; without one, interactions come over its Gateway connection |

Where each fake delivers events comes from the server's environment, one variable per channel: `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL`, with `SLACK`, `GITHUB`, `LINEAR`, `NOTION`, `RESEND`, `GOOGLE` or `DISCORD`.

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=https://my-agent.localhost/slack/events \
CHANNELSTACK_GITHUB_WEBHOOK_URL=https://my-agent.localhost/github \
npx channelstack
```

A Slack agent on Socket Mode connects out by itself and needs no URL.

- **Nothing else exists up front: no users, channels, repos or pages.** Tests create those themselves (see [section 5](#5-tests-plug-into-vitest-and-pytest)), so every test states exactly the world it needs and shares nothing with other tests.
- **The app's scopes hold.** channelstack rejects calls outside the granted scopes (`missing_scope`), just as Slack does.
- **Live, the app is your real one.** Its credentials come from environment variables (`CHANNELSTACK_SLACK_APP_ID`, `CHANNELSTACK_SLACK_BOT_TOKEN`, `CHANNELSTACK_GITHUB_APP_ID`, …; [live-mode.md](live-mode.md)).

**More apps, made by a test.** `my-agent` is still the app every fixture's `app` is (`slack.app`, `github.app`, …). A test that needs a second agent beside it, or another bot to talk to, makes one by name ([decision 0027](decisions/0027-multiple-apps.md)):

```ts
const coder = await slack.createApp({ name: "coder" });
const channel = await slack.createChannel({ participants: [ana, slack.app, coder] });
```

- **An app is a real app of its platform**, with its own ids, tokens and signing secret: a Slack app with a bot user, a GitHub App with its installation, a Linear app user, a Notion integration, a Resend team with its own domain (`<name>.acme.example`), a Gmail mailbox (`<name>@acme.example`). Each fake sends it what the platform would, including what the other apps do.
- **It joins where the platform puts apps:** `participants` on Slack, `createRepo({ apps })` or `repo.installApp` on GitHub, a delegation or a mention on Linear, `connections` on Notion, an email to its address on Resend and Google.
- **Found by its name.** The first `createApp({ name })` makes it; later calls with the same settings return it, from any session, so parallel tests share it as they share `my-agent`. A name is 1 to 32 lower-case letters, digits and hyphens, starting with a letter; `my-agent` is taken, and so is another setting under a taken name (`invalid_argument`). A channel holds 10 apps besides `my-agent`. A person and an app in one session can't share a name.
- **Its ids** come from `CHANNELSTACK_SEED` and its name, and **its secrets** are made once per install and kept in `secrets.json` with the rest, so its agent's `.env` stays valid across restarts.
- **Its events go** to `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL` (`coder` is `CODER`, `code-reviewer` is `CODE_REVIEWER`), read once at start; without one, and without a connection of its own (Slack's Socket Mode, Discord's Gateway, where the variable is its interactions endpoint), it receives nothing. `channelstack env --app coder` (or `channelstack.env({ app: "coder" })`) prints its lines under the keys `my-agent`'s have, so a second agent process starts from an `.env` of the same shape, and makes the app if no test has yet, so its agent can start first. `--channel slack` prints one channel's lines only.
- **A test can act as it** (`coder.say(…)`, `reviewer.comment(…)`), through the fake's API with its token, but never as `my-agent`, which the agent under test is. Every delivery says which app it went to (`delivery.app`), and `msg.deliveryFor(coder)` reads another app's.
- **Apps that answer each other without end** are stopped by the fake after 50 app messages in one conversation with no person between them; the test fails, naming the loop. `expect(thread).toGoQuiet({ within, maxReplies })` checks for it directly. Live has no such stop.

## 4. Driving it from the outside

The UI, the CLI, MCP and the test integrations all use one plain-HTTP control API at `https://channelstack.localhost/_channelstack`. So anything you can click, you can also script.

The API only listens on loopback and requires a bearer token. The server writes the token to `~/.channelstack/server.json` (mode 0600), where the CLI, MCP and test integrations find it on their own. The UI opens through a one-time login link printed on start.

The link signs one browser in and works once; `channelstack ui` prints a fresh one. A signed-in browser can only read what the UI shows (conversations, transcripts, the event log), with tokens scrubbed. It can't read `channelstack env` or change anything ([decision 0008](decisions/0008-ui-access.md)).

### 4a. The attach CLI

The CLI attaches to a running server. It finds it through portless (`channelstack.localhost`), or through `--server <url>` or `CHANNELSTACK_URL`. It's for poking the agent by hand while developing, and for shell scripts.

```bash
# Any channel: slack, github, linear, notion, resend, google, discord (people and places are created the first time they're named)
channelstack slack say   --as ana --in "#support" "@my-agent what broke last night?"
channelstack slack reply --as ben --to last "and the one before?"         # --thread works too
channelstack slack react --as ben :eyes: --on last
channelstack github say  --as mo --in "Login fails" "@my-agent can you look?"   # opens the issue, or comments on it
channelstack linear say  --as lu --in "Crash on start" "@my-agent take this"
channelstack notion say  --as nu --in "Roadmap" "@my-agent summarize this page"
channelstack resend say  --as re --in "Refund for order 1234" "Where is my refund?"   # an email to the agent
channelstack github show [--in "Login fails"] [--thread last] [--json]    # a place as a person reads it

# What else a channel's people do, generated from its routes
channelstack slack actions                                # click, stop, select, shortcut, invite, …; github: review, merge, label, …
channelstack slack click --as ana "Approve"               # the button in the latest message that has it
channelstack slack stop  --thread last                    # press Stop on the agent's work in the thread
channelstack linear delegate --as lu --in "Crash on start"   # to the agent's app; references the action needs come from the target
channelstack github review --as mo --review '{"event":"APPROVE"}'   # the newest entry's pull request (`last`); values in order or as --<name>

# Watching
channelstack show                                         # the most recently active place on any channel, as a person would read it
channelstack show --thread last                           # only the latest thread; --json for the entries and their ids
channelstack tail                                         # events to the agent and its API calls, as they happen; --once
channelstack ui                                           # a one-time link that opens the UI in a browser

# Deliveries (any channel)
channelstack deliveries [slack]                           # what was delivered, with ids, outcomes and attempts
channelstack redeliver [slack] [last|<id>]                # again, as the platform does: Slack's retry, with X-Slack-Retry-Num

# For a coding agent
channelstack mcp                                          # these commands as MCP tools over stdio (section 4b)

# The server and its setup
channelstack [start]                                      # --no-portless, --port <n>, --proxy, --proxy-port <n>, --record <dir>, --log-level <level>
channelstack env [--proxy] [--app <name>] [--channel <c>] # .env lines for the agent; --proxy for proxy mode; another app's, or one channel's
channelstack ca rotate                                    # a new CA for proxy mode
channelstack secrets rotate                               # new fake tokens and signing secrets

# Live mode
channelstack doctor                                       # which channels run live, their credentials and allowlists, saved browser sessions
channelstack login slack --user ana                       # sign Ana in by hand, once, and save the session for the browser actor
channelstack sweep                                        # remove leftovers from crashed runs; --older-than-hours, --run, --check
```

`--as <name>` creates that person the first time it's used, and `--in <place>` does the same for places, with the agent's app in them, so the dev loop needs no seed data either. A place is what people talk in on the channel, by its name: a Slack channel (`"#support"`), a GitHub issue or pull request by its title (in the org's public `dev` repository, whose admin is whoever first acted on GitHub; the others may do what anyone may on a public repository), a Linear issue by its title (in a team named Dev), a Notion page by its title (connected to the integration), an email thread by its subject (started with an email to the agent), a Discord channel (`"#support"`, private to its participants: the first person on Discord is the dev guild's admin, who adds the others). Every channel has `say`, `reply`, `show` and its actions; `react` where its people react (Slack, GitHub, Linear, Discord). `deliveries` and `redeliver` cover every channel.

`last` always refers to the most recent entry, thread or delivery, so a loop of "say, look, fix the code, say again" needs no IDs: on a channel, the newest entry of its most recently active place; for `show` without a channel, of any channel's. Any other entry is `<place>:<entry>`, as the commands print them and `show --json` lists the ids.

The actions are generated from the routes, like the SDKs ([decision 0028](decisions/0028-dev-tools-on-every-channel.md)): each method of a channel's person handle that isn't a read, with the same values (`channelstack <channel> actions` lists them). Values come in order or as `--<name> <value>`; a person or the app (`app`) is named, an object can be JSON, and one with a shorthand takes it as text (a button's label). A reference the action needs and wasn't given comes from the target: the entry `--on` names, the newest one in the place `--in` names, or `last`. Without `--as`, whoever started the target's thread acts. An action named like a verb is `channelstack <channel> act <action>` (Slack's own `say`, with its files and blocks). A retry after a delay, a bad signature or a stale timestamp are for tests: the SDK's `delivery.retry({ after })` and `delivery.resend({ badSignature: true })`.

Everything the CLI does happens in one shared session called `dev`, which the UI shows too. It lives until the server stops ([decision 0010](decisions/0010-dev-session-and-attach-cli.md)).

### 4b. MCP for coding agents

```json
{ "mcpServers": { "channelstack": { "command": "npx", "args": ["channelstack", "mcp"] } } }
```

The MCP tools are the attach CLI's commands, each written once for both (`server/src/cli/`), on every channel the same way ([decision 0028](decisions/0028-dev-tools-on-every-channel.md)):

- `say`, `reply`, `react` and `show`, each with a `channel` (`channelstack <channel> say|reply|react|show`; `show` without one is `channelstack show`).
- `<channel>_act` for everything else that channel's people do (`slack_act`, `github_act`, …): an `action` enum generated from the routes, the action's values as `params`, and `as`, `in` and `on` as on the CLI. Its description lists each action's values.
- `tail` (what happened since its last call), `list_deliveries` and `redeliver` (`channelstack deliveries [<channel>]`, `channelstack redeliver [<channel>] [last|<id>]`; Slack retries the way Slack does, the others redeliver).

They act in the shared `dev` session and never return the server's token. That gives a coding agent a feedback loop while it edits the bot: post as Ana, read what the bot answered, redeliver, check again. The `channelstack` skill (`skills/channelstack/SKILL.md`, for skills.sh) comes with it, the same way portless and emulate ship theirs.

What differs per channel (what a place is, how a person says, replies and reacts there) is the channel's dev adapter (`core/dev`, `definition.dev`); the rest is the same for every channel, and the UI lists the places the adapters find (`/places`), and `pnpm check:channels` requires an adapter for each.

## 5. Tests: plug into Vitest and pytest

channelstack has no test package of its own to import. It integrates into the test framework you already use. Each integration does three things:
1. starts channelstack, or attaches to one that's running;
2. injects channel handles into the test context;
3. extends that framework's `expect` with channel matchers.

### Vitest

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import channelstack from "channelstack/vitest";

export default defineConfig({ plugins: [channelstack()] });
// adds globalSetup (start or attach), a setup file that registers matchers,
// and types for the test context
```

The plugin takes `mode` (`auto`, `attach` or `start`), `server` (a URL to attach to), `timeout` (default 10s) and `quietFor` (default 750ms). The two defaults apply to every matcher and to every wait in the SDK: `waitFor…`, `latest…`, the reads that wait for quiet, and actions that wait for a button to appear. A project that sets no `testTimeout` gets one from the plugin: 30s, or three times `timeout` if that's longer, so a failing check reports its own message instead of Vitest's 5s "Test timed out". A project's own `testTimeout` always wins.

```ts
import { test, expect } from "vitest";

test("answers once, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });   // fresh per test
  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent");
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");   // nothing leaked outside the thread
});

test("honours Stop and approves once", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const msg = await ana.say("@my-agent deploy web to staging", { channel });

  const reply = await msg.thread.latestReply({ from: "my-agent" });
  await ben.click("Approve", { message: reply });
  await ben.click("Approve", { message: reply });            // double click
  await expect(msg.thread).toContainText("Deploying", { count: 1 });

  await ana.stop({ thread: msg });
  await expect(msg.thread).toHaveStatus("stopped");
});

test("survives Slack's 3s retry", async ({ slack }) => {
  const ben = await slack.createUser({ name: "Ben" });
  const channel = await slack.createChannel({ participants: [ben, slack.app] });
  const msg = await ben.say("@my-agent hi", { channel });
  await msg.delivery!.retry({ after: "3s" });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});

test("doesn't answer its own PR comment", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ name: "web", files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
  const pr = await ana.openPullRequest({ from: "fix-login" }, { repo });
  await ana.comment("@my-agent review this", { issue: pr });
  await expect(pr).toHaveCommentsFrom("my-agent", { count: 1 });  // no self-trigger loop
});
```

#### API shape: actor first, content first, location as an option

Every action is a method on the **person** who takes it. The content comes first, and where it happens is an option named after the resource:

```ts
await ana.say("@my-agent deploy web", { channel });
await ben.click("Approve", { message: reply });
await ana.comment("@my-agent fix this", { issue: pr });
await ana.delegate(linear.app, { issue });
await ana.reply("thanks!", { discussion });
```

| Channel | Calls on a user |
|---|---|
| Slack | `say(text, { channel } \| { to })` · `reply(text, { thread })` · `edit(text, { message })` · `delete({ message })` · `react(emoji, { message })` · `click(label, { message } \| { thread })` · `select(option, { menu, message })` · `runCommand("/deploy web", { channel })` · `stop({ thread })` · `waitForModal()` · `openDM(app)` · `openAgentThread()` · `pickPrompt(title, { thread })` · `invite(people, { channel })` |
| GitHub | `push(changes, { repo, branch })` · `openIssue({ title }, { repo })` · `openPullRequest({ from }, { repo })` · `comment(text, { issue })` (an issue or a PR) · `review({ pr, event, comments })` · `reviewComment(text, { pr, path, line })` · `reply(text, { comment })` · `resolve({ comment })` · `label(names, { issue })` · `assign(people, { issue })` · `requestReview(people, { pr })` · `merge({ pr })` · `rerun({ checkRun })` |
| Linear | `createIssue({ title }, { team })` · `comment(text, { issue })` · `reply(text, { comment })` · `delegate(linear.app, { issue })` · `prompt(text, { session })` · `answer(text, { elicitation })` · `stop({ session })` · `assign(user, { issue })` · `setState(name, { issue })` |
| Notion | `comment(text, { page, anchor? })` · `reply(text, { discussion })` · `resolve({ discussion })` · `edit({ append }, { page })` · `mention(notion.app, { page })` · `setProperty(name, value, { page })` · `addRow(values, { database })` · `connect(notion.app, { page })` |
| Resend, Google | `send({ to, cc, subject, text, html })` · `reply(email, { text, all })` · `inbox()` · `waitForEmail({ from })` |
| Discord | `say(text, { channel } \| { to })` · `reply(text, { message })` · `edit(text, { message })` · `delete({ message })` · `react(emoji, { message })` · `startThread(name, { message } \| { channel })` · `runCommand("/deploy web", { channel })` · `click(label, { message } \| { channel })` · `openDM(app)` · `invite(people, { channel })` · `ephemeral()` |

Why this shape:
- **It reads as a sentence:** "Ana says … in the channel", "Ben clicks Approve on the reply". Autocomplete on `ana.` shows everything a person can do on that platform.
- **The type system keeps people on their own platform.** `ana` from `slack.createUser` has no `comment`, and a GitHub user has no `say`, so mixing them up is a compile error.
- **Where it happens is named,** so `{ channel }`, `{ thread }`, `{ issue }` and `{ session }` are visible at the call site. Shorthand properties keep it short when the variable has the same name.
- **Resources are only read and waited on** (`channel.messages()`, `thread.latestReply({ from: ... })`, `session.waitForActivity(...)`). There's one way to act and one way to look.
- **Actions with no person behind them stay on the fixture or the delivery:** `slack.createChannel(...)`, `delivery.retry()`, `delivery.redeliver()`, `modal.submit(...)` (a modal belongs to one person).
- **Every action returns what it created** (a message, comment, session or delivery), so you can chain the next step without looking anything up.
- **It matches the CLI**, which was already actor-first: `channelstack slack say --as ana --in "#support" "…"`.

- **Every test creates its own world.** `createUser`, `createChannel({ participants })`, `createRepo`, `createTeam` and `createPage` are system-level, so they live on the channel fixture.
- **The agent's access is explicit, just as on the real platforms.** Each fixture has an `app` handle for the agent's app, and nothing grants it access behind your back:

  | Channel | Real-platform rule | In a test |
  |---|---|---|
  | Slack | a bot gets events from, and can post in, only the channels it's a member of (`not_in_channel` otherwise) | `createChannel({ participants: [ana, slack.app] })` |
  | GitHub | an App receives webhooks only for repos it's installed on | `createRepo({ apps: [github.app] })` |
  | Notion | an integration sees only pages explicitly connected to it | `createPage({ connections: [notion.app] })` |
  | Linear | an app is installed workspace-wide | installed from the start; nothing per resource |

  Leaving the app out is how you test the uninvited case: the agent should handle `not_in_channel` cleanly, or call `conversations.join` when it ought to. Shared fixtures can include the app once, so tests stay short.
- **Every action returns the thing it created** (a message, comment, session or delivery), so you can chain the next step without looking anything up.

#### Users as shared fixtures

People you use across many tests belong in your own fixtures file. That's plain Vitest `test.extend` (pytest fixtures work the same way):

```ts
// test/fixtures.ts
import { test as base } from "vitest";
import type { SlackConversation, SlackUser } from "channelstack";

export const test = base.extend<{ ana: SlackUser; ben: SlackUser; support: SlackConversation }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  ben: async ({ slack }, use) => use(await slack.createUser({ name: "Ben", admin: true })),
  support: async ({ slack, ana, ben }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, ben, slack.app] })),
});
```

```ts
import { expect } from "vitest";
import { test } from "./fixtures";

test("answers in #support", async ({ support, ana }) => {
  const msg = await ana.say("@my-agent what broke last night?", { channel: support });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});
```

Each test still gets fresh users and a fresh channel (fixtures are created per test), so parallel tests never share state. Fixtures also compose: `support` depends on `ana` and `ben`.

**Why there are no predefined users, and where each benefit goes instead:**

| Benefit of predefined users | Without them |
|---|---|
| People exist for the UI and CLI before any test runs | The CLI and UI create users on first use (`--as ana`, or the user picker) |
| Stable user IDs, for agents that allowlist admins by ID (`ADMINS=U0ADMIN01`) | `createUser({ name: "Cara", id: "U0ADMIN01" })` accepts a fixed ID |
| The same person across Slack, GitHub, Linear, Notion, Resend, Google and Discord | A test creates one user per channel under the same name (`slack.createUser({ name: "Ana" })`, `github.createUser({ login: "ana" })`). Most tests don't need more |
| Less setup per test | Shared fixtures (above) are one line per test and visible where they're used |

So predefined users would add nothing worth keeping, and they'd bring hidden shared state, which parallel tests can't afford.

#### Cleanup: the session does it

Everything a test creates (channels, PRs, issues, pages) belongs to its session, and closing the session removes it, so tests just use `const`. Three handles implement `Symbol.asyncDispose`, for code that runs outside a fixture (a script, a `beforeAll` block): the client, a session, and an injected Slack fault.

```ts
await using session = await client.openSession();              // what it created is removed when the scope ends
await using fault = await slack.fault({ type: "rate_limit" });  // undone when the scope ends
```

`await using` needs TypeScript ≥ 5.2 with the `esnext.disposable` lib, or a runtime with native support. A dispose step only cleans up; it never asserts anything.

- The fixtures (`slack`, `github`, `linear`, `notion`) come from Vitest's own test context, so you import `test` and `expect` from `vitest` as usual.
- Each fixture creates its own channel, PR, issue or page, so tests run in parallel against one server.

### The integrations

| Framework | Integration | Fixtures | Matchers |
|---|---|---|---|
| Vitest | `channelstack/vitest` plugin | test context (`({ slack }) =>`) | `expect.extend` |
| pytest | `pytest-channelstack` plugin | `channelstack` (the client), `channelstack_session`, `slack`, `github`, `linear`, `notion` | `expect(thread).to_have_reply_from("my-agent")`, `not_to_…` for negations ([decision 0018](decisions/0018-pytest-expect.md)) |

### pytest

`pip install pytest-channelstack` registers the plugin. A test asks for the fixtures it needs, and awaits `expect(...)`:

```python
import re
from pytest_channelstack import expect

async def test_a_mention_gets_one_reply(slack):
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@my-agent summarize yesterday's incidents", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.I))
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
    await expect(channel).not_to_have_channel_message_from("my-agent")
```

- **Fixtures:** `channelstack` is the client for the whole run (`env()`, `reset()`); `channelstack_session` is the test's session, closed after it; `slack`, `github`, `linear` and `notion` are the channels' fixtures in it.
- **One event loop.** The client outlives each test, so tests and fixtures run on the run's loop. With pytest-asyncio, set it once:

  ```ini
  [pytest]
  asyncio_mode = auto
  asyncio_default_fixture_loop_scope = session
  asyncio_default_test_loop_scope = session
  ```

- **Settings:** `--channelstack-mode attach|start|auto` (or `channelstack_mode` in the ini file), `channelstack_timeout` (10s) and `channelstack_quiet_for` (750ms). As with Vitest, the two defaults apply to every check and to every wait in the SDK (`wait_for_…`, `latest_…`).
- **Live mode:** a test that does something live mode can't do is skipped with the reason, as with Vitest.

### The matchers

All matchers are **asynchronous and wait until the condition holds or a timeout passes**. A test never needs `sleep`.

- **Positive** matchers resolve once the condition holds.
- **Negative and exact-count** matchers (`not.…`, `toHaveRepliesFrom`) wait until the agent goes quiet. channelstack knows when that is: no open stream, no request from the agent in flight, no retry it was told to make later, no delivery in flight or about to be retried (Slack's retries a minute or more away don't hold a check up), and a short settle window that the matcher watches from start to end. It then checks the result. When a check fails or a wait gives up, the message also says what the agent left open, for example `Still open: a stream my-agent started and never stopped: "Thinking…"` ([decision 0009](decisions/0009-quiet-means-watched.md)).

Every matcher reads the **transcript**: each channel's state reduced to what a person would read. Edits are applied, deleted messages are gone, stream chunks are joined, ephemeral messages are visible only to their recipient, and Block Kit text and button labels are extracted. The UI shows the same transcript.

| Channel | Matchers |
|---|---|
| Slack | `toContainText(text \| RegExp)`, `toHaveReplyFrom(app)`, `toHaveRepliesFrom(app, { count: 1 })`, `toHaveChannelMessageFrom(app)`, `toHaveStreamingReplyFrom(app)`, `toHaveStatus("working" \| "streaming" \| "stopped" \| "idle")`, `toHaveStatusText(text)`, `toHaveButton(label)`, `toHaveReaction(emoji, { by })`, `toHaveOpenedModal(title)`, `toBeEphemeralFor(user)` |
| GitHub | `toHaveCommentFrom(app)`, `toHaveCommentsFrom(app, { count })`, `toHaveReviewComment({ path, line, from })`, `toHaveCheckRun(name, { status, conclusion })`, `toHaveLabel(name)`, `toBeMerged()` |
| Linear | `toHaveSessionState("pending" \| "active" \| "stopping" \| "awaitingInput" \| "complete" \| "error")`, `toHaveActivity({ type, from, text })`, `toHaveCommentFrom(app)`, `toBeDelegatedTo(app)`, `toBeAssignedTo(user)`, `toHaveState(name)` |
| Notion | `toHaveCommentFrom(app)` and `toHaveCommentsFrom(app, { count })` on a discussion, `toHaveBlock(text \| RegExp)`, `toHavePropertyValue(name, value)` (asymmetric matchers such as `expect.any(Number)` work) |
| Resend, Google | `toHaveReplyFrom(app)` and `toHaveRepliesFrom(app, { count })` on a thread: its answers, without the quoted history |
| Discord | As Slack's: `toHaveReplyFrom(app)` and `toHaveRepliesFrom(app, { count })` on a message (Discord's replies to it and its thread), a thread or a DM, `toContainText`, `toHaveButton`, `toHaveReaction`, `toBeEphemeralFor` |
| Any delivery | `toBeAccepted({ within: "3s" })`, `toBeRejected()` (bad signature), `toBeRetried({ times })` |

The matchers assert on **behaviour** (once, in the thread, stopped, acknowledged in time, on the right line), not on exact wording. So they hold whether the agent uses a real model or a fake one.

### Standard checks

The standard checks are a helper that registers ordinary tests in your suite:

```ts
import { slackChecks, githubChecks, linearChecks, notionChecks } from "channelstack/checks";

slackChecks({ app: "my-agent" });    // ~12 tests: replies once to a DM and to a mention, stays in thread,
                                    // survives the 3s retry, idempotent on redelivery, ignores itself
                                    // and other bots, rejects a bad signature, handles msg_too_long,
                                    // stream starts and stops, honours Stop, refuses unauthorised
                                    // clicks, a double click acts once
githubChecks({ app: "my-agent" });   // ignores its own comments, one comment per trigger, review-thread
                                    // replies trigger, check run reaches a conclusion
linearChecks({ app: "my-agent" });   // a first activity within 10s, ends its turn, Stop ends the session,
                                    // a redelivery doesn't start the work again, rejects stale and
                                    // badly signed webhooks
notionChecks({ app: "my-agent" });   // answers in the discussion it was asked in, ignores its own comments,
                                    // a webhook sent again doesn't answer twice, rejects a bad signature
```

Each check is named after a bug class found in real apps (`app-developers.md`). The UI's **Checks** panel runs the same set.

Ten of the Slack checks need nothing but the prompt. The stream and Stop checks need `streamPrompt` (text that makes the agent stream a longer answer), and the two click checks need `approval: { prompt, button }` (text that makes it ask for an approval, and the button's label). Without those options the checks are left out, as with `skip: ["slack.stream-stop"]`. `slack.double-click` counts messages: it expects the agent to answer one approval with exactly one new message in the thread (replacing the question as well is fine); an agent that answers only in place, or with several messages, skips it. Every check's id is in its test name.

## 6. The model is yours

channelstack doesn't mock or intercept LLM calls. Every framework already has its own fake model:
- the AI SDK has `MockLanguageModelV2`;
- Pi and Flue have `fauxProvider`;
- LangChain has `FakeListChatModel`;
- MDA's tests use LangChain's `FakeListChatModel` in `defineDeepAgent`;
- OpenClaw has mock-openai.

A test can use one of those, or a real model. The matchers are designed for this split: they check *how* the agent behaved in the channel, not *what* the model said. For example, `toHaveRepliesFrom` holds with any reply text.

## 7. The UI is functional, not faithful

Nobody needs the UI to look like Slack, GitHub, Linear, Notion or an inbox. What matters is that a developer can **use** each channel and **see what happened**. So the UI uses one neutral design for every channel and shows the same transcript the matchers read. Its list of places is every channel's, from the same dev adapters the CLI and MCP use (`GET /sessions/{session}/places`, decision 0027):

- **Threads and conversations as text:** who said what, in which thread, edited or deleted, streaming or done, and the agent's status ("thinking…", "stopped").
- **Interactive elements that work:** a button is a button, a select is a select, and a modal opens as a plain form. Clicking one sends the real `block_actions` or `view_submission` delivery. The same goes for GitHub review comments (shown with path and line), Linear Stop, and Notion comment replies.
- **The raw payload one click away:** every message expands to its JSON (blocks, attachments, metadata), and every delivery and API call expands in the inspector.
- **No product styling, no attempt at full Block Kit layout.** For exact Block Kit previews, link to Slack's Block Kit Builder.

This keeps the UI cheap: one generic transcript view plus generic controls, not four product clones. It also keeps it honest, because the UI can't show anything the matchers wouldn't see.

## 8. CI

```yaml
- run: npx channelstack start --no-portless --port 4500 &   # with CHANNELSTACK_<CHANNEL>_WEBHOOK_URL in the job's env
- run: npx channelstack env >> $GITHUB_ENV
- run: pnpm start &                                   # the agent, against the env above
- run: pnpm vitest run                                # the plugin attaches to the running server
```

With `--no-portless` the server serves `http://localhost:4500/{slack,github,linear,notion}` on one loopback port, with no TLS to trust, and `channelstack env` prints those URLs. A Docker image covers Python, Go and other stacks.

## 9. Proxy mode: for agents that can't change their base URL

Some agents hard-code `slack.com` or `api.github.com`, or run on stacks you don't control (MDA's Trigger Server, Go services). For those:

```bash
npx channelstack start --proxy                 # also an HTTP proxy on 127.0.0.1:7464
npx channelstack env --proxy >> .env.local     # HTTPS_PROXY plus a CA trusted only by the agent
```

- **Routing:** the proxy sends `slack.com`, `api.github.com`, `api.linear.app` and `api.notion.com` to the same fakes that `*.localhost` serves, and passes every other host through. With `--proxy` the fakes' own URLs (Socket Mode's WebSocket, upload URLs) are the providers' too, so the agent needs no channelstack URL at all.
- **What `env --proxy` prints:** the fake tokens and signing secrets, without the API URLs, and:
  - `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (loopback and `*.localhost` stay direct);
  - `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS`, and `NODE_OPTIONS` with a preload that keeps Node's proxy-aware `fetch` when the agent loads undici (Bolt does). It replaces an agent's own `NODE_OPTIONS`: an agent that sets some puts them on the same line, after the `--import`;
  - `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`: the public roots plus channelstack's CA.
- **Trust:** it uses channelstack's own CA (`~/.channelstack/ca/`, 0600). The CA is name-constrained to those hosts (not their subdomains) and to no IP address, and never added to the system trust store. Only the agent's environment trusts it. `channelstack ca rotate` replaces it.
- **Go on macOS** ignores `SSL_CERT_FILE`, so run Go agents in Docker or on Linux for proxy mode. Use `docker run --network host`, mount the bundle file alone (`-v ~/.channelstack/ca/bundle.pem:/etc/channelstack/bundle.pem:ro`, never the whole directory: the CA's key is next to it), and point `SSL_CERT_FILE` at it inside the container (`examples/agents/go-slack` does this).
- **Live:** in proxy mode a live channel's agent still talks to the real platform; the proxy passes its calls on. Reading those calls back live (`calls()`, Slack's status) isn't built yet.

## 10. Live mode: the same tests against the real platforms

Credentials make things real. Without them everything is fake. With them, the same test talks to a real sandbox workspace:

```ts
// the server's environment holds the real app's credentials in CI (CHANNELSTACK_SLACK_APP_ID, CHANNELSTACK_SLACK_BOT_TOKEN, …)

// in a test: a real person, if CHANNELSTACK_SLACK_USER_ANA_TOKEN is set; fake otherwise
const ana = await slack.createUser({ name: "Ana" });
```

- **One test file, two runs.** CI runs it fake on every PR and live nightly, with no edits. `CHANNELSTACK_REALITY=fake` forces fake locally, even with credentials present.
- **Safety:** live mode only runs in workspaces, orgs and teams listed in `CHANNELSTACK_LIVE_*` allowlists, and refuses anywhere else with `live_not_allowlisted` before it does anything there. Everything a test creates carries the run's tag in its name (`channelstack-run-<run>-…`) and is removed when its session closes: Slack channels are archived, and what the test wrote in a DM is deleted.
- **Acting, not relaying.** Live mode acts on the real platform (as the app, or as a person with their token) and reads the results back. The platform delivers events to your agent directly; how your agent is reachable is up to it. Delivery chaos (retries, bad signatures, redelivery) is fake-only.
- **UI-only actions** such as Slack button clicks, Stop and modal submit have no public API. Live, the **browser actor** does them in a browser, with the session that `channelstack login slack --user <name>` saved for that person.
- **A bot token alone** acts as the bot, never as a person. Person actions need a user token per sandbox person. On Slack, that token comes from a separate app for the sandbox's people. A person's message is the exception: Slack marks one posted through its API with the posting app's bot, and agents ignore it, so a person's `say` and `reply` work live: the browser actor types them in the client, with their saved browser session.
- **What live can't do skips, with the reason.** A fake-only step (delivery chaos such as `delivery.retry()`) is refused with `unsupported_in_live`, and one that needs a piece live mode doesn't drive yet (the browser actor beyond typing and clicking, proxy mode) with `action_requires`. Vitest reports the test as skipped with that reason, for example `[live: SlackUser.click live needs the browser actor: …]`. The fake run on every PR runs it in full. A setup that can't work fails instead, so a broken nightly run goes red: credentials set in part or a token of the wrong kind (`live_misconfigured`), or a person without a token acting in a live workspace (`fake_actor_in_live_world`; `live_misconfigured` already at `createUser` under `CHANNELSTACK_REALITY=live`).
- **Checking the setup and cleaning up:**

  ```bash
  channelstack doctor                      # per channel: fake or live, credentials, allowlist, saved browser sessions
  channelstack sweep                       # what crashed runs left: their ledgers, and tagged objects older than 24h
  channelstack sweep --check --run <id>    # remove nothing; exit 1 if that run left anything (the nightly job's check)
  channelstack login slack --user ana      # sign Ana in by hand, once; the browser actor uses the saved session
  ```

  `CHANNELSTACK_RUN_ID` names the run (CI sets it per job); without it, each server makes one up.
- **It keeps the fakes honest.** The nightly run compares fake and live transcripts. Where they differ, the fake gets fixed, or the difference is recorded as a known divergence. The published coverage page shows the result per action.

[live-mode.md](live-mode.md) is the build spec: how each live action is done (as the app, as a person, or in the browser) and how results are observed. [reality-matrix.md](reality-matrix.md) lists every method with what it needs live: a user token, app credentials, the browser actor, the relay or proxy mode, or nothing (fake-only). The details (reality rules, per-platform credentials, cleanup ledger) are in the implementation plan, sections 5, 9 and 12.

## 11. TLS trust across runtimes

portless trusts its CA in the system store, but not every runtime reads that store. Set what each one needs:

| Runtime | Setting |
|---|---|
| Node ≥ 24 | `NODE_USE_SYSTEM_CA=1` (or `NODE_EXTRA_CA_CERTS=<portless CA>`) |
| Python (certifi) | `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` = a bundle of certifi plus the portless CA |
| Go | the macOS keychain works as is; on Linux, `SSL_CERT_FILE` |
| Anything awkward | `--no-portless`: plain HTTP on one loopback port |

## 12. Package layout

| Package | Purpose |
|---|---|
| `channelstack` | CLI, the client and the test integrations. The root export is the client and its types (`import type { SlackUser } from "channelstack"`), as is `channelstack/client`; the integrations are `channelstack/vitest` and `channelstack/checks`. The server is a single binary, installed per platform through optional dependencies (`@channelstack/server-<platform>`) |
| `pytest-channelstack` | pytest plugin: fixtures and `expect(...)` checks over the control API |

> The exact TypeScript types are the generated SDK's (`sdks/typescript`), and the Vitest integration targets Vitest 5. Examples are in `test/acceptance/examples/`.

## 13. Settled since the first draft

1. **Notion v0.1:** comment webhooks with `X-Notion-Signature` (HMAC-SHA256 with the verification token), page and database events, integration mentions in comments and page bodies. Person actions use personal access tokens ([reality-matrix.md](reality-matrix.md)).
2. **The GitHub API host:** the fake serves both `github.localhost` as the API root (like `api.github.com`) and the GHE-style `github.localhost/api/v3`, because some SDKs assume the GHE layout when a host is set (phase 3).
3. **Settle window:** `quietFor` defaults to 750 ms, configurable per integration (`channelstack({ quietFor })`, `channelstack_quiet_for`), which sets it for every matcher and SDK wait, and per call (`{ quietFor: "1s" }`).

Open questions for the maintainer are listed in [AGENTS.md](../AGENTS.md#still-open).
