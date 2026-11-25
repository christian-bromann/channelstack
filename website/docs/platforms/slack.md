---
title: "Slack"
order: 1
description: "Test a Slack agent against channelstack's fake Slack, from connecting Bolt or the Chat SDK to buttons, modals, streams, Stop and retries."
---

# Slack

This page shows how to test an agent built on Slack's APIs: how to point it at the fake, which people and channels a test creates, what those people can do, and what you can check afterwards. It assumes you have run [Getting started](/docs/getting-started) once.

> [!TIP]
> Every method, option and wait of the Slack fake, with each call in TypeScript, Python and Rust, is in the [Slack API reference](/docs/reference/api/slack).

```ts title="agent.test.ts"
import { test, expect } from "vitest";

test("a mention gets exactly one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /incident/i });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
});
```

## What the fake covers

The fake Slack is one workspace (`Acme`) with one app installed in it, named `my-agent`. It serves the Web API at `https://slack.localhost/api/` and delivers the Events API, interactivity and slash commands to your agent, over HTTP or Socket Mode.

| Area | What's there |
|---|---|
| Messages | `chat.postMessage`, `update`, `delete`, `postEphemeral`, `response_url` answers, Block Kit blocks, message metadata |
| Streaming | `chat.startStream`, `appendStream`, `stopStream`, and the Stop button |
| Agents and assistants | `assistant.threads.setStatus`, `setSuggestedPrompts`, `setTitle`, `agents.sessions.setStatus` and `rename`, the split view events |
| Conversations | Public and private channels, DMs and group DMs: `conversations.history`, `replies`, `info`, `list`, `members`, `open`, `join` |
| People | `users.info`, `users.list`, `auth.test` |
| Reactions and files | `reactions.add`, `remove`, `get`; `files.getUploadURLExternal`, `completeUploadExternal`, `info` |
| Interactivity | `block_actions` (buttons, select menus), `views.open`, `push`, `update`, `view_submission`, `view_closed`, message shortcuts, slash commands |
| Events | `app_mention`, `message.*`, `reaction_added` and `removed`, `member_joined_channel` and `left`, `app_uninstalled`, `tokens_revoked`, `agent_session_stopped`, `assistant_thread_started`, `assistant_thread_context_changed` |
| Transport | HTTP request URL with Slack's signature, Socket Mode (`apps.connections.open` and the WebSocket) |

The app has the scopes a conversational agent usually has (`chat:write`, `app_mentions:read`, the `*:history` and `*:read` scopes, `reactions:write`, `files:write`, `users:read`, `assistant:write` and a few more). A method outside them answers `missing_scope`, as Slack does.

Not covered yet: Slack Connect channels (`createChannel({ shared: true })` answers `unsupported_in_fake`), renaming and archiving channels, attaching files to a person's message, Workflow Builder, Canvases and Lists. A Web API method the fake doesn't have answers `unknown_method`.

## Connecting a Slack agent

Ask the running server for the agent's settings:

```bash
npx channelstack env
```

```ini
SLACK_API_URL=https://slack.localhost/api/
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_SIGNING_SECRET=…
```

The tokens and the signing secret are random, made once for your machine and kept in `~/.channelstack/secrets.json`. They stay the same across restarts until you run `channelstack secrets rotate`. With `--no-portless`, the URL is `http://127.0.0.1:4500/slack/api/` instead.

Every Slack SDK takes a base URL for the Web API. Set it from `SLACK_API_URL`, and leave it unset in production, where the SDK falls back to `https://slack.com/api/`.

```ts title="Bolt for JavaScript"
import { App } from "@slack/bolt";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(process.env.SLACK_API_URL ? { clientOptions: { slackApiUrl: process.env.SLACK_API_URL } } : {}),
});

await app.start(3000);
```

```python title="Python (slack_sdk)"
import os
from slack_sdk import WebClient

client = WebClient(
    token=os.environ["SLACK_BOT_TOKEN"],
    base_url=os.environ.get("SLACK_API_URL", "https://slack.com/api/"),
)
```

In Bolt for Python, pass that client to the app: `App(client=client, signing_secret=os.environ["SLACK_SIGNING_SECRET"])`.

The Chat SDK's Slack adapter reads `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_API_URL` from the environment by itself, so it needs no option:

```ts title="Chat SDK"
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

const slack = createSlackAdapter({ agentView: true });
const bot = new Chat({ userName: "my-agent", adapters: { slack }, state: createMemoryState() });

// Serve bot.webhooks.slack(request) at /slack/events.
```

An agent that hard-codes `slack.com` (slack-go, most Go and Rust clients) can't take a base URL. Run it in [proxy mode](/docs/guide/proxy-mode) instead.

### Where events are delivered

channelstack never starts your agent; it sends events to a URL you give it when the server starts:

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events npx channelstack start
```

Events, interactions (buttons, menus, modals, shortcuts) and slash commands all go to that one URL, which is how Bolt and the Chat SDK serve them by default. `/slack/events` is Bolt's default path and the one the reference agents use. Any slash command name is accepted.

Without `CHANNELSTACK_SLACK_WEBHOOK_URL` and without a Socket Mode connection, nothing is delivered: a person's message is stored, but the app hears nothing. See [Connecting your agent](/docs/guide/connecting-your-agent) for TLS trust and the other runtimes.

### Socket Mode

An agent in Socket Mode connects out and needs no request URL. Give Bolt the app token:

```ts title="agent.ts"
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: process.env.SLACK_API_URL },
});

await app.start();
```

Bolt calls `apps.connections.open` with the `xapp-…` token through the same base URL, and the fake hands back a WebSocket URL on its own host. From then on, deliveries go over the socket instead of the request URL. Attempts, retries and the quiet rule work the same on both transports. `slack.socketConnections` says how many connections the agent holds right now.

While the agent is between connections, a delivery waits for it to reconnect until its ack window ends. An agent that also has a request URL and has held no socket for 30 seconds is reached over HTTP again.

## People and channels in a test

A test creates the people it needs and the places they talk in. Nothing is declared in a config file, and nothing is shared between tests unless you share it with `test.extend` (see [Writing tests](/docs/guide/writing-tests)).

```ts
const ana = await slack.createUser({ name: "Ana" });
const ben = await slack.createUser({ name: "Ben", admin: true });
const deployBot = await slack.createUser({ name: "deploy-bot", bot: true });
const cara = await slack.createUser({ name: "Cara", id: "U0ADMIN01" });
```

| Option | What it does |
|---|---|
| `name` | Required. How mentions (`@Ana`) and matchers find the person |
| `id` | A fixed user id, for agents that allowlist people by id. Generated (`U…`) otherwise |
| `displayName`, `realName`, `email`, `timezone` | Profile fields the agent reads with `users.info` |
| `admin`, `owner` | Workspace roles. `users.info` shows `is_admin`, `is_owner` |
| `guest` | A guest restricted to the channels it's added to |
| `bot` | Another bot, to check that the agent ignores bots |
| `token`, `browser` | Live mode only: see [Live](#live) |

Channels have only the members you list. The app is a member only when you include `slack.app`, which is Slack's own rule: an app that isn't in a channel gets no events from it and can't post there (`not_in_channel`).

```ts
const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
const incidents = await slack.createChannel({ name: "incidents", private: true, participants: [ana, slack.app] });
```

| Option | What it does |
|---|---|
| `participants` | People and the app. Only they are members |
| `name` | Without `#`. Generated (`test-<id>`) if omitted. Unique per test session, so parallel tests can each have a `#support` |
| `private` | A private channel: the app reads it with the `groups:*` scopes, and an outsider gets `channel_not_found` |
| `topic`, `purpose` | Shown by `conversations.info` |

A DM needs no channel: `ana.say("hi", { to: slack.app })` opens one, and `ana.openDM([ben, slack.app])` opens a group DM. The app is always in a DM with itself. To add the app later, a person invites it: `await ana.invite(slack.app, { channel })` sends `member_joined_channel`.

## What people do

Every action is a method on the person who takes it. The content comes first, and where it happens is an option. Each one resolves to what it created: a message, a delivery or a modal. The [API reference](/docs/reference/api/slack) lists every method and option.

### Messages, threads, reactions and edits

```ts
const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
await msg.thread.waitForReply({ from: "my-agent" });

await ana.reply("and the API?", { thread: msg });
await ana.edit("@my-agent what's the status of the web deploy today?", { message: msg });
await ana.react("ticket", { message: msg });
await ana.delete({ message: msg });
```

`@name` in a message becomes a real mention (`<@U…>`) of that person or app; write `@@` for a literal `@`. A mention of the app sends `app_mention`, and the message also sends `message.channels` (or `.groups`, `.im`, `.mpim`). `msg.delivery` is the `app_mention` delivery; `msg.deliveries()` lists them all.

`say` and `reply` also take `{ text, blocks, metadata }` for a message with Block Kit or message metadata. `reply` takes `alsoSendToChannel: true` to broadcast the reply.

### Buttons, menus, modals, commands and shortcuts

```ts
const ask = await msg.thread.latestReply({ from: "my-agent" });
await ben.click("Approve", { message: ask });

await ana.select("staging", { menu: "Environment", message: ask });

await ana.click("Open form", { thread: msg.thread });
const modal = await ana.waitForModal({ title: /incident/i });
await modal.submit({ Severity: "SEV2", Summary: "Checkout errors" });

await ana.runCommand("/deploy web staging", { channel });
await ana.shortcut("create_ticket", { message: report });
```

A button is found by its visible label or by `{ actionId, value }`. Without `message`, `click` uses the latest agent message in the thread (or channel) that has the button. Like a person, `click`, `select` and `pickPrompt` wait for the control to appear: they try again while it isn't there, up to the timeout, and then fail with a list of what was there.

A modal is the one the agent opened for that person with `views.open`. `submit` fills inputs by label or by `block_id.action_id` and sends `view_submission`; `close` sends `view_closed` if the agent asked for it. `modal.errors` holds what the agent answered with `response_action: "errors"`. `ana.modals()` lists every modal the agent opened for Ana, open or not.

### Streams, status and Stop

```ts
const msg = await ana.say("write a long report on Q3", { to: slack.app });
await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

await ana.stop({ thread: msg });
await expect(msg.thread).toHaveStatus("stopped");
```

`stop` presses Stop on the agent's work in a thread and sends `agent_session_stopped`. After that, `chat.appendStream` and `chat.stopStream` on that stream answer `stopped_by_user`.

### The agent split view

```ts
const thread = await ana.openAgentThread({ from: incidents });
const prompts = await thread.suggestedPrompts();

await ana.pickPrompt("What changed?", { thread });
await ana.switchContext(general, { thread });
await ana.reply("summarize this channel", { thread });
```

`openAgentThread` sends `assistant_thread_started` (with the channel Ana is looking at as its context), `switchContext` sends `assistant_thread_context_changed`, and `pickPrompt` posts the prompt's message as Ana. An app that isn't subscribed to those events gets `split_view_unavailable`.

### Conversations and membership

`ana.openDM(ben)` or `ana.openDM([ben, slack.app])` opens or reuses a DM; `ana.invite(...)` and `ana.kick(...)` change who's in a channel. `ana.ephemeral()` returns the messages only Ana can see, once the agent is quiet.

### What only the test does

Some things have no person behind them. They live on the fixture or the delivery:

```ts
await slack.uninstallApp();                    // app_uninstalled and tokens_revoked
await slack.fault({ type: "rate_limit", operation: "chat.postMessage", retryAfter: "1s", times: 1 });
await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });
```

## What to check

The matchers read what a person would see: edits applied, deleted messages gone, stream chunks joined, button labels as text, ephemeral messages only for their recipient. Positive matchers resolve as soon as the condition holds; `.not` and exact counts wait until the agent is quiet first. [Waiting and quiet](/docs/guide/waiting-and-quiet) explains why.

| Matcher | Subject | Reads |
|---|---|---|
| `toHaveReplyFrom(author, { text })` | thread, DM | `thread.replies()` |
| `toHaveRepliesFrom(author, { count })` | thread, DM | `thread.replies()`, once quiet |
| `toHaveChannelMessageFrom(author)` | conversation | `conversation.messages()` (outside threads) |
| `toContainText(text, { count, from, as })` | anything with a transcript | `transcript()` |
| `toHaveStreamingReplyFrom(author)` | thread | `message.stream` |
| `toHaveStatus(state)`, `toHaveStatusText(text)` | thread | `thread.status()` |
| `toHaveButton(label)` | message, thread | `message.blocks` |
| `toHaveReaction(emoji, { by })` | message | `message.reactions()` |
| `toHaveOpenedModal(title)` | person | `user.waitForModal()` |
| `toBeEphemeralFor(user)` | message | `message.visibleTo` |
| `toBeAccepted`, `toBeRejected`, `toBeRetried` | delivery | `delivery.attempts` |
| `toHaveReceivedCall(operation, { times, error })` | `slack` | `slack.calls()` |

`thread.status()` is `working` while a status line is set, `streaming` while a reply streams, `stopped` after Stop and `idle` when done. The [matchers reference](/docs/reference/matchers) has every option.

Every matcher is built on a read you can call yourself: `channel.messages()`, `thread.replies()`, `thread.latestReply({ from })` (once the agent is quiet), `message.refresh()`, `message.stream`, `thread.status()`, `slack.calls({ operation, error })`, `slack.deliveries()`. A transcript reads like the conversation and makes a good snapshot:

```ts
const transcript = await msg.thread.transcript();
expect(transcript.toString()).toMatchSnapshot();
```

A full test, an approval that must act once even on a double click:

```ts title="approvals.test.ts"
import { test, expect } from "vitest";

test("approval buttons act once, even on a double click", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const msg = await ana.say("@my-agent deploy web to staging", { channel });

  const ask = await msg.thread.latestReply({ from: "my-agent" });
  await expect(ask).toHaveButton("Approve");

  await ben.click("Approve", { message: ask });
  await ben.click("Approve", { message: ask });

  await expect(msg.thread).toContainText("Deploying", { count: 1 });
  await expect(slack).not.toHaveReceivedCall(/.*/, { error: "not_in_channel" });
});
```

To run the same checks every Slack agent should pass (one reply to a mention, survives the 3-second retry, rejects a bad signature, honours Stop), add `slackChecks()` from `channelstack/checks`. See [Standard checks](/docs/guide/standard-checks).

## Delivery specifics

### Signatures and headers

Every HTTP delivery carries Slack's signature over the exact bytes sent:

| Header | Value |
|---|---|
| `X-Slack-Request-Timestamp` | Seconds since the epoch |
| `X-Slack-Signature` | `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>`, keyed with `SLACK_SIGNING_SECRET` |
| `X-Slack-Retry-Num`, `X-Slack-Retry-Reason` | On retries only |

Events are JSON (`event_callback` with `event_id`, `team_id`, `api_app_id`). Interactions are form-encoded with a `payload` field, and slash commands are form-encoded fields, as on Slack. Your agent should refuse a signature that doesn't match and a timestamp more than five minutes old: `delivery.resend({ badSignature: true })` and `resend({ stale: true })` check that it does.

### Acknowledgement and retries

The agent has 3 seconds to answer an event with a 2xx. If it doesn't, the fake retries the way Slack does: the same payload and `event_id`, almost at once, then after a minute, then after five minutes, with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` (`http_timeout`, `http_error` or `connection_failed`). An answer with `X-Slack-No-Retry: 1` ends the retries. Interactions and slash commands are not retried.

In a test, `msg.delivery!.retry({ after: "3s", reason: "http_timeout" })` sends a retry on purpose, so you can check the agent answers once:

```ts
await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });
await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
```

Over Socket Mode, the same retry arrives as an envelope with `retry_attempt` and `retry_reason`. [Delivery and failures](/docs/guide/delivery-and-failures) covers redelivery, faults and what each proves.

### Faults

`slack.fault(...)` changes how the Web API answers the agent until it's undone or the test ends:

| Fault | Effect |
|---|---|
| `{ type: "rate_limit", operation, retryAfter, times }` | HTTP 429, `Retry-After` in seconds, error `ratelimited` |
| `{ type: "latency", operation, delay }` | The call answers late |
| `{ type: "error", operation, error, times }` | The call fails with that Slack error, such as `msg_too_long` |
| `{ type: "drop_socket", after }` | Cuts the Socket Mode connections once, without a goodbye |

### What the fake refuses

The fake refuses what Slack refuses, with Slack's error code (`{ ok: false, error }`). The ones agents meet most:

| Error | When |
|---|---|
| `not_authed`, `invalid_auth` | No token, or a token that isn't the app's |
| `not_allowed_token_type` | The bot token on `apps.connections.open`, or the app token anywhere else |
| `missing_scope` | A method outside the app's scopes, with `needed` and `provided` |
| `not_in_channel`, `channel_not_found` | Posting where the app isn't a member (public, or private and DM) |
| `is_archived`, `message_not_found`, `thread_not_found` | What the names say |
| `cant_update_message`, `cant_delete_message` | Editing or deleting someone else's message |
| `user_not_in_channel` | `chat.postEphemeral` to someone outside the channel |
| `msg_too_long` | A message or stream over Slack's length limit |
| `stopped_by_user`, `message_not_in_streaming_state` | Writing to a stream after Stop, or one that has ended |
| `invalid_trigger_id`, `expired_trigger_id`, `exchanged_trigger_id` | `views.open` with a bad, more than 3-second-old or already used `trigger_id` |
| `hash_conflict` | `views.update` with an outdated `hash` |
| `already_reacted`, `no_reaction` | Adding a reaction twice, removing one that isn't there |
| `account_inactive` | Any call after `slack.uninstallApp()` |
| `unknown_method` | A method the fake doesn't have |

A test's own action can be refused too: `name_taken` for a second channel with the same name in one session, `split_view_unavailable`, `dispatch_failed` when the app has no request URL and no socket, and `not_found` when a button never appeared. The [errors reference](/docs/reference/api/errors) lists them all.

## Live

The same tests can run against a real Slack sandbox workspace. Set the app's credentials (`CHANNELSTACK_SLACK_APP_ID`, `CHANNELSTACK_SLACK_BOT_TOKEN`), allowlist the workspace with `CHANNELSTACK_LIVE_SLACK_TEAMS`, and give each sandbox person a user token (`CHANNELSTACK_SLACK_USER_ANA_TOKEN` for `createUser({ name: "Ana" })`). Live, Slack delivers to your agent itself; channelstack acts and reads the results back.

Slack marks every message posted through its API as an app's, so a person's `say` and `reply` are typed in Slack's own client by the browser actor, and so is `click`. Save each person's browser session once with `channelstack login slack --user ana`, or pass `browser: { storageState }` to `createUser`. Edits, deletes, reactions, invites and every read go through the user token.

Still fake only: `select`, `shortcut`, `runCommand`, `stop`, the agent split view, `uninstallApp`, fixed ids, faults and the delivery checks (`retry`, `resend`, `toBeAccepted`). Live runs skip those steps and say why. See [Live mode](/docs/guide/live-mode) and the [API reference](/docs/reference/api/slack).
