# 0027: A channel holds any number of agent apps

Status: accepted, 2026-11-27, on the maintainer's instruction. The design below is proposed for phase 12, and the questions at the end are the maintainer's. It reverses the clause of AGENTS.md's settled "Test API" row that gives each fake one app, and the "one App, one installation" of [decision 0013](0013-github-fake.md), which now holds per App.

## What was decided

- **A channel holds any number of people and apps.** Each app is a real app of its platform, with its own identity (ids in the platform's format), its own credentials, its own delivery endpoint and subscriptions. It hears what the real platform would send it, including what the other apps do.
- **A test adds an app with `createApp({ name })`** on the channel's fixture and puts it where the platform puts apps: `participants: [ana, slack.app, coder]`, `createRepo({ apps: [github.app, reviewer] })`, `connections: [notion.app, writer]`.
- **`my-agent` stays.** Every fake keeps its built-in app, `slack.app` and the other fixtures' `app` are still it, and `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` and `channelstack env` mean what they mean today. No existing test, check, variable or agent changes.
- **Apps belong to the shared world, not to a session**, as `my-agent` does: an agent process is configured once, so its app outlives each test. A session still scopes what happens in its own conversations, issues, pages and threads. There is still one world per channel: the one workspace, org or guild every app is installed in (for Resend, the fake platform's teams, one per app; for Twilio, the account and its numbers). AGENTS.md's "World" row says so.
- **channelstack still never starts an agent.** Each app is driven by its own agent process, or one process holds several apps. channelstack still doesn't mock models.

## Why

A friend asked whether channelstack could host agent swarms. Agents increasingly share a channel with other agents: a triage agent hands an issue to a coding agent, a review App comments on a coding App's pull request, two vendors' bots sit in one support channel, a Linear issue is delegated to one agent while another watches its comments. The bugs that come with it only show with two real apps in one place:

- **Reply loops.** Two agents answer each other without end. Bolt's `ignoreSelf` only drops an app's own messages; GitHub sends an App webhooks for other Apps' actions, and Actions' "a `GITHUB_TOKEN` event starts no workflow" rule doesn't apply to Apps.
- **Answering what was meant for another app**: an agent that acts on every `message` or `issue_comment`, not only what mentions it or its own agent session.
- **Telling bots apart the wrong way.** An agent that ignores Slack messages with `subtype: "bot_message"` still answers a modern app, whose messages carry `bot_id`, `app_id` and `bot_profile` and no subtype.
- **One process, several apps**: verifying with the wrong signing secret, answering with the wrong token, routing a GitHub delivery by repository instead of by `installation.id`.

Today a test can only add Slack's `createUser({ bot: true })` (and Discord's, in phase 11): a scripted user with a `bot_id`, without an app, credentials or events. It shows whether an agent ignores a bot; it can't stand for another agent.

## Design

### The test API

The public API is the generated SDKs ([decision 0025](0025-no-hand-written-contract.md)); `api/*.d.ts` no longer exists. So the contract is two routes per channel, and the TypeScript below is what the generator makes of them:

```text
POST /sessions/{session}/<channel>/apps        { name, …the channel's settings }   → the channel's app (role "app")
GET  /sessions/{session}/<channel>/apps                                            → my-agent first, then the others in the order they were made
```

```ts
// sdks/typescript/generated/index.ts, as generated (sketch)
class SlackFixture {
  readonly app: SlackApp; // my-agent, unchanged
  createApp(options: { name: string; scopes?: string[]; botEvents?: string[] }): Promise<SlackApp>;
  apps(): Promise<SlackApp[]>;
}

class SlackApp {
  readonly id: string;        // A…
  readonly name: string;      // as people mention it: "coder"
  readonly botUserId: string; // U…
  readonly botId: string;     // B…
  readonly botToken: string;  // xoxb-…, fake only; "" live
  readonly appToken: string;
  readonly signingSecret: string;
  // Scripted acting, extra apps only (see "Scripted apps"): the acting methods SlackUser has,
  // with the same signatures (say, reply, edit, delete, react, unreact, …).
  say: SlackUser["say"];
  reply: SlackUser["reply"];
  react: SlackUser["react"];
}
```

```ts
test("the triage agent hands off to the coder", async ({ slack }) => {
  const coder = await slack.createApp({ name: "coder" });
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app, coder] });

  const msg = await ana.say("@my-agent the login page answers 500", { channel });

  await expect(msg.thread).toHaveReplyFrom(slack.app, { text: /@coder/ });
  await expect(msg.thread).toHaveReplyFrom(coder, { text: /pull request/ });
  await expect(msg.thread).toGoQuiet({ within: "10s", maxReplies: 4 }); // at most 4 app messages since Ana's
});
```

Rules that hold on every channel:

- **An app is found by its name.** `createApp({ name: "coder" })` makes the app the first time any session asks for it, and returns the same app afterwards, so parallel tests share it as they share `my-agent`. The same name with other settings is refused with `invalid_argument`. A name is 1 to 32 lower-case letters, digits and hyphens, starting with a letter (`coder`, `code-reviewer`), unique per channel; `my-agent` is reserved. With no `_` in names, each name has one variable name (`code-reviewer` is `CODE_REVIEWER`), and an app's variables always end in a credential after the name, so none reads as an existing variable such as `CHANNELSTACK_SLACK_APP_ID`.
- **A name in a matcher** (`toHaveReplyFrom("coder")`) is looked up among the session's people and the apps the session has used (`my-agent`, and each app it got from `createApp`), so what another test does can't change its meaning. A name that is both a person's and an app's in that session is refused with `invalid_argument`, asking for the handle.
- **A limit of 10 apps per channel** keeps a run from making apps without end, since they live as long as the server (open question 3).
- **Its ids** come from the seeded id generator, derived from `CHANNELSTACK_SEED` and the app's name, so they don't depend on the order tests make apps in.
- **Its secrets** are made once per install from the CSPRNG when the app is first made, and kept in `secrets.json` (0600) beside the driver's own, under `apps.<name>`, each checked against the driver's format for it as the driver's own are. Today `Secrets.load` keeps only what the drivers declare, so it learns to keep the apps' too: they stay across restarts, and the app's agent's `.env` stays valid. `channelstack secrets rotate` rotates them with the rest. The redactor's token shapes cover them, since they have the shapes `my-agent`'s have.
- **Where its events go** is `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL`, read once at start like today's variable. An app without one, and without a connection it opened itself (Slack's Socket Mode, Discord's Gateway), is unreachable, as `my-agent` is today. Open question 2: a `webhookUrl` option on `createApp` as well.
- **`channelstack env --app coder`** prints the app's variables under the same keys `channelstack env` prints for `my-agent` (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, …), so a second agent process starts from an `.env` of the same shape. It makes the app if no test has yet, so the agent can start first. The `channelstack.env({ app })` fixture does the same.
- **Every delivery says which app it went to.** `deliveries({ app })` filters; `msg.delivery` stays the delivery to `my-agent`, and `msg.deliveryFor(coder)` reads another app's.
- **Faults** stay workspace-wide by default, and take `app` to hit one app's calls only.
- **Uninstalling:** Slack's `slack.uninstallApp()` takes the app, defaulting to `my-agent`; GitHub's `repo.uninstallApp(app)` already takes one.
- **Echo**, the internal driver, gets `createApp` too, so the smoke scenarios can hold every SDK to it.

### Scripted apps, and Slack's `createUser({ bot: true })`

Three kinds of bot, from least to most real:

| Kind | Made with | Who acts | What others see |
|---|---|---|---|
| Scripted bot user | `slack.createUser({ bot: true })` (Discord too, phase 11) | The test (`bot.say`) | A user with `is_bot` and a `bot_id`, without an app: no `app_id`, no `bot_profile`, no credentials, no events. What a legacy bot or an integration without an app posts |
| Scripted app | `createApp({ name })`, acted as by the test (`peer.say`) | The test, through the fake's own API with the app's token | Exactly what that app's own call would send: `bot_id`, `app_id`, `bot_profile` on Slack, `peer[bot]` on GitHub |
| Agent app | `createApp({ name })`, with an agent process holding its credentials | The agent | The same |

The two app kinds are one app; the difference is only who acts. An app handle has the acting methods a person has on that channel (`say`, `reply`, `react`; `comment`; `send`; …), for apps made with `createApp` only: acting as `my-agent` is refused with `invalid_argument`, because the agent under test is the one that acts as it. A test should script an app only when no agent drives it: the fake can't tell, and two writers in one app confuse the transcript (open question 4).

The scripted app is what lets a check suite test the reply loop without a second agent: the check scripts a peer app that answers everything the agent says (below).

`createUser({ bot: true })` stays as it is: `slack.ignores-bots` and the examples use it, and it is the cheapest way to say "a bot wrote this". It isn't an app, so it can't receive events, hold a token or be mentioned as an app. Open question 5: whether its messages should carry a stand-in app's `app_id` and `bot_profile`, as almost every bot's do on Slack today.

### Per channel

What an app is, how it gets its credentials, and which of one app's actions the platform sends to the others. "To confirm" marks what isn't known from documentation or the probes. Until the live spike answers it (B1–B10 below), the fake does what the row says, its tests hold it to that, and the reality matrix marks the row unconfirmed; an answer that differs changes the fake and its test.

#### Slack

- **An app:** an app with a bot user installed in the one workspace, with `my-agent`'s scopes and bot events unless `createApp` gives others. Its own `xoxb-`, `xapp-` and signing secret; its own Request URL, or its own Socket Mode connection with its app token.
- **It joins** like `my-agent`: `participants`, `invite`, `openDM`.
- **What it hears from another app B**, if it is a member and subscribed:
  - B's messages as `message.channels` (and `.groups`, `.mpim`) with B's `user`, `bot_id`, `app_id` and `bot_profile`, and no subtype. Edits and deletes as `message_changed` and `message_deleted`.
  - A message of B's that mentions it: `app_mention` with B's `bot_id`, as the fake already sends for a scripted bot (to confirm, B1).
  - B's reactions as `reaction_added` and `reaction_removed`, with B's bot user as `user`.
  - B joining or leaving as `member_joined_channel` and `member_left_channel`.
- **Its own actions come back to it** as Slack sends them (the fake does this today); Bolt's `ignoreSelf` drops them.
- **What another app can't do:** open a DM with a bot (`conversations.open` refuses with `cannot_dm_bot`, to confirm, B2), click another app's button, run its slash command, or open, stop or switch an agent thread: interactions, `agent_session_stopped` and assistant threads are a person's and go to the app they belong to only.
- **Per app:** rate limits per token and method; `auth.test` answers as the token's app.

#### GitHub

- **An app:** a GitHub App, installed on the org with selected repositories: its own App id, slug, `<name>[bot]` bot user, private key, webhook secret and webhook URL. `GITHUB_APP_ID` and the others, per app, from `env --app`.
- **It joins** with `createRepo({ apps: [github.app, reviewer] })` or `repo.installApp(reviewer)`, which sends that App `installation_repositories` only.
- **What it hears from another App B,** for every event it subscribes to on a repository it is installed on: B's comments, issues, labels, pull requests, reviews, review comments and pushes, with `sender: { login: "b[bot]", type: "Bot" }`. One event that two Apps hear is two deliveries: each with its own GUID, signed with its own App's secret, with that App's `installation.id` and `X-GitHub-Hook-Installation-Target-ID`.
- **Its own actions come back to it**, as GitHub sends them: there is no `GITHUB_TOKEN`-style suppression for Apps, which is where the loop comes from.
- **Checks:** `check_run` `rerequested` and `requested_action` go to the App that made the check run only; `created` and `completed` go to every subscribed App (to confirm, B3). `check_suite` `requested` goes to each App with checks permission.
- **Tokens:** an installation token is the App's and acts as `b[bot]`. For another App's installation the fake refuses it: a JWT for another installation's token with 404, a repository the installation doesn't cover with 404, a permission the App lacks with 403 `Resource not accessible by integration` (to confirm the codes, B10).

#### Linear

- **An app:** an OAuth app installed with `actor=app`, with its own app user (mentionable and assignable), access token, client id and secret, webhook URL and secret, and its own subscriptions (`AgentSessionEvent`, `Issue`, `Comment` by default).
- **It joins** by being delegated to or mentioned: `ana.delegate(coder, { issue })`, `createIssue({ delegate: coder })`, `"@coder …"` in a comment. An issue has one delegate; delegating to another app moves it.
- **Agent sessions are per app.** A session belongs to the app it was opened for, and its `AgentSessionEvent`s (`created`, `prompted`, the stop signal) go to that app only. Another app's activities can't be posted into it (to confirm the error, B4).
- **What it hears from another app B:** `Issue` and `Comment` webhooks for B's changes in its teams, with B's app user as the actor (to confirm the actor's shape, B5). Whether an app's comment that mentions another app opens a session for it, and whether an app may delegate to another app, are to confirm (B6); until then the fake refuses both with the error a person-only action gets, and the matrix says so.

#### Notion

- **An app:** an internal integration with its own bot user, token and capabilities, and its own webhook subscription: URL, verification handshake and verification token.
- **It joins** a page through its connections: `createPage({ connections: [notion.app, writer] })`, inherited by child pages as today. It sees only pages it is connected to.
- **What it hears from another integration B,** on pages it is connected to: `page.*` and `comment.*` events for B's changes, with `authors: [{ id: <B's bot>, type: "bot" }]`, batched like a person's (to confirm that Notion sends events for an integration's changes to the others, and to the integration itself, B7).
- **What another integration can't do:** mention it. Notion's changelog ("User mentions can only be of people") says the API takes user mentions of people only, so an integration hands off by comment or page, not by `@`. Until B7 confirms the refusal and its code, the fake refuses an integration's mention of a bot with `validation_error`.

#### Resend

- **An app:** a team of its own: its own API key, webhook secret and webhook URL, and its own receiving domain, `<name>.acme.example` unless `createApp({ domain })` says otherwise, with the address `<name>@<domain>`. A domain belongs to one team, so two teams can't share `acme.example`. Open question 6: a second address on `my-agent`'s team instead, one webhook routed by recipient, as many real setups do.
- **It joins** a thread by being a recipient: `ana.send({ to: [resend.app, billing] })`, or an agent's email to it.
- **What it hears from another app B:** an email B sends to its address is an `email.received` on its team's webhook, threaded by `Message-ID` and `References` like a person's. B's team gets B's own `email.sent` and `email.delivered`.
- **Loops:** an auto-reply to an auto-reply is the oldest email loop. The fake keeps every header an agent sets, so a check can see whether an agent marks its answers (`Auto-Submitted: auto-replied`, RFC 3834) and leaves a message so marked unanswered.

#### Google (Gmail)

- **An app:** a mailbox of its own, `<name>@acme.example` (one Workspace domain holds many mailboxes), with its own OAuth client, refresh token, Pub/Sub topic and push endpoint (the webhook URL, which is also its tokens' audience).
- **What it hears from another app B:** B's email to it lands in its mailbox and its watch pushes, at most once a second, as today. B's mailbox history changes too (the `SENT` label), so B's watch pushes as well, and an agent that reads every history change as new mail answers its own answer: a loop of one agent.
- **Loops:** as for Resend, the headers an agent sets are kept, and `Auto-Submitted` can be checked.

#### Twilio (phase 10)

- **An app:** a phone number of its own on the agent's account, with its own messaging webhook URL. Twilio signs every webhook with the account's Auth Token, so two numbers on one account share it; that is the platform, not a shortcut. `createApp({ subaccount: true })` puts the number on a subaccount with its own Account SID and Auth Token instead (open question 7).
- **What it hears from another app B:** B's text to its number is an inbound message on its webhook, as a person's is; B gets its own status callbacks. A text costs money live, and two numbers texting each other is the most expensive loop there is, so the guard below matters most here.
- **Opt-out:** `STOP` from B stops it texting B, as for a person.

#### Discord (phase 11, once PR #103 lands)

- **An app:** an application with a bot user in the guild: its own token, application id, public key, interactions endpoint URL (the webhook URL) and Gateway connection with its own intents.
- **It joins** with `participants`, which gives it the channel's permissions.
- **What it hears from another app B:** `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE` and reactions over its own Gateway connection, with `author.bot: true` and B's id. The content is empty without `MESSAGE_CONTENT`, unless the message mentions it.
- **What another app can't do,** as phase 11 already found for people played by bots: write to it in a DM (refused with 50007), run its slash commands, or press its buttons. Interactions are people's only.
- **Live:** phase 11's people are second applications already. An app made with `createApp` is a different application from every person's.

### The reply loop as a bug class

A loop is the same conversation (thread, issue, pull request, page discussion, email thread, pair of numbers) receiving app messages with no person's action between them, for longer than a correct swarm needs.

- **The matcher:** `expect(thread).toGoQuiet({ within, maxReplies })` waits until the conversation is quiet (the quiet detector, as negative matchers do) and fails when that takes longer than `within`, or when the conversation holds more than `maxReplies` app messages since its last person's message, counting those written before the check began. Its message names the authors in turn: `my-agent → coder → my-agent → coder … (14 replies, no person between them)`. It is in matchers-core, so Vitest, pytest and Rust share its semantics. `toHaveRepliesFrom(app, { count, quietFor })` already bounds one app's replies, and stays.
- **The guard:** without one, two looping fakes run as fast as the machine allows, and the test only stops at its timeout. The fake counts app-authored messages per conversation since the last person's action; at 50 (open question 1) it stops delivering events caused by apps in that conversation, records a `bot_loop` event naming the conversation and the authors, and fails the session: the fixture fails the test at teardown with that message, and `toGoQuiet` fails at once. The real platforms throttle instead (rate limits) and never stop, so the guard isn't platform realism. It is a harness stop, set far above what a correct swarm sends, and it is never silent; the reality matrix lists it as fake only. Live mode has no guard: the agents receive from the real platform, and channelstack doesn't stand between them.
- **One owner:** the guard is core's, a new `core/loops/` in the code map. Each driver tells it, through its world's one message path, the conversation and whether a person or an app wrote; the delivery kit asks it before sending an event an app caused. No driver counts. `bot_loop` is a new kind in the event log, so the generated event types change with it (`pnpm spec`, `pnpm sdk`).
- **The check:** each `<channel>Checks()` gets `<channel>.no-reply-loop`. A scripted peer app answers every message the agent writes in a conversation, and the agent must stop answering it within a few turns without a person (the count is an option, default 3). The broken agents get a variant that answers every app. Agents built to hand off to each other set the option, or skip the check.

### Live mode

Live mode still acts on the real platforms and reads the results back; it never relays events. So every extra app is a real sandbox app, made by hand once (creating apps through an API is not what the platforms' terms are for, and live mode records differences instead of automating accounts), with its own agent process deployed at its own public URL.

- **Credentials per app:** `CHANNELSTACK_<CHANNEL>_APP_<NAME>_<CREDENTIAL>`, with the credentials `my-agent` has live: `CHANNELSTACK_SLACK_APP_CODER_APP_ID` and `…_BOT_TOKEN`, `CHANNELSTACK_GITHUB_APP_REVIEWER_APP_ID` and `…_PRIVATE_KEY`, `CHANNELSTACK_LINEAR_APP_CODER_TOKEN`, `CHANNELSTACK_NOTION_APP_WRITER_TOKEN`, `CHANNELSTACK_RESEND_APP_BILLING_API_KEY` and `…_ADDRESS`, the Google OAuth client and refresh token, the Twilio number (and subaccount), the Discord bot token. They stay in the server's memory like every live credential, are never logged, and are never returned: an app handle's tokens are empty live, and `env --app` prints nothing for a live channel.
- **Checked when made:** `createApp` live finds the app by those variables, and checks its token is an app's (not a person's and not `my-agent`'s), that no other app has it, and that it is installed in an allowlisted workspace, org, team or guild. Missing variables are `live_misconfigured`, naming them; the allowlists are unchanged.
- **Cleanup:** the app isn't made or deleted by a run. What a scripted app writes is tagged and on the ledger like a person's, and the sweep finds it.
- **The spike:** each sandbox app's Request URL points at the nightly run's internal receivers (phase 6, live-mode.md section 6), so the run records what the platform sent the other app and the differ compares it with the fake. That answers the B items of each channel with a second sandbox app, and keeps answering them. The others stay "to confirm" until their channel has one (open question 8).

| # | To confirm live |
|---|---|
| B1 | Slack sends `app_mention` to an app that another app's message mentions, with the other's `bot_id` |
| B2 | Slack refuses a bot's `conversations.open` with another bot (`cannot_dm_bot`) |
| B3 | GitHub's `check_run` actions: which go to every subscribed App, and which only to the App that made the run |
| B4 | Linear's error for an app posting an activity into another app's agent session |
| B5 | The actor of a Linear `Issue` or `Comment` webhook for an app user's change |
| B6 | Whether a Linear app's comment mentioning another app opens a session for it, and whether an app may delegate an issue to another app |
| B7 | Whether Notion sends an integration events for another integration's changes, and for its own; and its refusal of a bot mention |
| B8 | Twilio delivers a text between two numbers of one account as an inbound message, with the same signature |
| B9 | Discord's `MESSAGE_CREATE` for another bot's message, with and without `MESSAGE_CONTENT` |
| B10 | GitHub's codes for one App's token or JWT used on another App's installation |

### What it means for each part

- **Routes and drivers:** each driver's store holds apps by name instead of one `app`, and every place that asks "is this the app?" asks "which app?": delivery (each subscribed member app gets its own, signed with its own secret, at its own URL or connection), the fake API's token lookup (each token answers as its app), mentions, membership and permission checks. Each driver's `world.ts` keeps one implementation per action, now for any app; core's delivery kit takes the target app's secret and URL per delivery instead of the driver's one.
- **Secrets and env:** `core/secrets` keeps per-app secrets under the driver; each driver's definition gives `env(app)` instead of `env()`; `app.ts` serves `env?app=`; the CLI's `env` gets `--app`.
- **The SDK generator:** nothing new in the IR for `createApp` and `apps()`, which are a factory and a method like `createUser` and `users()`. The channel unions already list every handle whose role is `app`. App handles gain methods (`sdkMethod on: "SlackApp"`), which the generator supports for users already. Python and Rust get the same from the same IR; `pnpm sdk:check` holds them.
- **The matchers:** they already take an app handle or a name as the author. A name now resolves against the session's people and the apps the session used (unique by the rule above), as a mention in a person's text does; core's `AppRoster` keeps which apps each session used, and forgets them when it closes. `toGoQuiet` is new, in matchers-core, the pytest `expect` and the Rust crate.
- **The transcripts:** each entry's author already has a `kind` and a name; apps are told apart by their names (`coder: opened #12`). The UI shows each app with its name and a bot badge, and its inspector lists deliveries per app.
- **The `*Checks()` suites:** today `app` only sets the prompt and the matchers' author, and the checks use the fixture's `app` (`slack.app`) and `msg.delivery` directly. The suite now resolves `app` to its handle once (`createApp` for any name but `my-agent`), and every check uses that handle and `msg.deliveryFor(handle)`, so `slackChecks({ app: "coder" })` runs every check against the agent driving `coder`. `<channel>.no-reply-loop` is new on every channel.
- **Proxy mode:** the fakes already tell callers apart by their credentials, not by host, so several apps through the proxy need nothing new; `channelstack env --app coder --proxy` prints what proxy mode adds for that app.
- **The CLI and MCP:** the attach commands and MCP tools act as people, as today, and their transcripts name each app; `channelstack deliveries` takes `--app`. Acting as an app from the terminal is left for later.
- **Conformance:** each channel with a second sandbox app gets a two-app scenario in `scenarios/<channel>/`, and the differ compares each app's deliveries with the fake's; differences go into `divergences.yaml` as today.
- **`pnpm check:channels`:** every channel needs `createApp` and `apps()`, an app schema with role `app`, per-app secrets and env, the delivery cases A1–A3, the "several apps" examples and `<channel>.no-reply-loop`.
- **The quiet detector:** already counts every delivery and call in flight; it counts every app's.

## Alternatives considered

- **Keep one app, and grow `createUser({ bot: true })`** with more bot-like payloads on every channel. Cheaper, but a scripted bot has no credentials and receives nothing, so it can't be an agent, and the loop needs two agents or an app that answers.
- **Apps per session**, made and dropped with each test like people. Their credentials would change every test, and an agent process is configured once.
- **Declare apps at server start** (`CHANNELSTACK_SLACK_APPS=coder,reviewer`) instead of `createApp`. It fixes every app before any test, but it is a config file by another name, and a test couldn't say which apps it needs. With ids derived from the name and secrets kept per install, `createApp` gives the same stability.
- **One webhook URL for all of a channel's apps,** the target app in a header. No platform does that: each app has its own endpoint and secret, and an agent hosting two apps has to route as it would in production.
- **No loop guard, only the matcher.** Honest to the platforms, but a looping test spins until its timeout, and a looping dev session spins until someone stops it.

## Open questions for the maintainer

| # | Question | Default if unanswered |
|---|---|---|
| 1 | The loop guard: stop at how many app messages without a person, and should tripping it fail the test, or only stop and record? | 50, and it fails the test |
| 2 | Besides `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL`, may `createApp({ webhookUrl })` say where an app's events go? | No: the variable only, read at start, as today |
| 3 | The limit of apps per channel | 10 |
| 4 | Scripted apps: may a test act as an extra app (`peer.say`), fake and live? The loop checks need it | Yes, for apps made with `createApp`; never as `my-agent` |
| 5 | Should Slack's `createUser({ bot: true })` messages carry a stand-in app's `app_id` and `bot_profile`, like a modern bot's? | No: unchanged, and the difference noted in the reality matrix |
| 6 | Resend: an extra app as its own team (own key, webhook and domain), or as another address on `my-agent`'s team? | Its own team, `createApp({ domain })` to choose the domain |
| 7 | Twilio: an extra number on the agent's account (shared Auth Token, as Twilio signs), or on a subaccount of its own? | The agent's account; `subaccount: true` for its own |
| 8 | Live mode: which channels get a second sandbox app in phase 12? Each is set up by hand, and Twilio's costs money per text | Slack, GitHub and Linear; the others fake only until their sandbox apps exist |
