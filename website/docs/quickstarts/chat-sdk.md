---
title: "Chat SDK"
order: 2
description: "Run a Chat SDK bot against channelstack's fake Slack, pass a first Vitest test, then point the same bot at GitHub and Linear."
---

# Chat SDK

In this tutorial you write a Slack bot on the [Chat SDK](https://chat-sdk.dev) (`chat` with `@chat-adapter/slack`), run it against channelstack's fake Slack, and test that it answers a mention and the follow-ups in its thread. Then you break it once and read the failure. It follows the `chat-sdk-slack` reference agent that channelstack's CI runs.

If you haven't used channelstack before, [Getting started](/docs/getting-started) explains the server, `channelstack env` and the test in more detail. This page moves faster.

## 1. Create the project

You need Node.js 24 or newer, which runs the TypeScript files below as they are.

```bash
mkdir chat-agent && cd chat-agent
npm init -y
npm pkg set type=module
npm i chat@4.45.0 @chat-adapter/slack@4.45.0 @chat-adapter/state-memory@4.45.0
npm i -D channelstack vitest
```

These are the versions channelstack's CI runs the reference agent with.

## 2. Start channelstack

In a second terminal, start the server and tell it where the bot takes Slack's events:

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=http://127.0.0.1:3000/slack/events \
  npx channelstack start --no-portless --port 4500
```

Back in the first terminal, write the bot's settings to a file:

```bash
npx channelstack env > .env.local
```

The Chat SDK's Slack adapter reads three of those lines on its own: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_API_URL`. The last one points it at the fake. In production you leave it unset and the adapter talks to Slack.

## 3. Write the bot

The Chat SDK handles web-standard `Request` objects, so the bot needs a small HTTP server around it. This one is the helper the reference agents use:

```ts title="serve.ts"
import { createServer } from "node:http";

/** One handler for one path, 404 for everything else. */
export function serve(port: number, path: string, handle: (request: Request) => Promise<Response>): void {
  createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method ?? "GET",
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === "POST" ? { body } : {}),
    });
    const response = incoming.url === path ? await handle(request) : new Response("not found", { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, "127.0.0.1");
}
```

The bot answers a mention in its thread, subscribes to that thread, and then answers what people write there without a new mention:

```ts title="agent.ts"
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

import { serve } from "./serve.ts";

const bot = new Chat({
  userName: "my-agent",
  adapters: { slack: createSlackAdapter() },
  state: createMemoryState(),
  logger: "warn",
});

/** The question without the mention: Slack sends `<@U…>`, the Chat SDK may resolve it to `@name`. */
const question = (text: string) => text.replace(/<@[A-Z0-9]+>|@[\w-]+/g, "").trim();

bot.onNewMention(async (thread, message) => {
  if (message.author.isBot === true) return;
  await thread.subscribe();
  await thread.post(`On it: ${question(message.text)}`);
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.post(`On it: ${question(message.text)}`);
});

serve(3000, "/slack/events", (request) => bot.webhooks.slack(request));
```

Nothing in it knows about channelstack. Start it in a third terminal:

```bash
node --env-file=.env.local agent.ts
```

## 4. Write the tests

Add the Vitest plugin:

```ts title="vitest.config.ts"
import channelstack from "channelstack/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [channelstack()],
});
```

And two tests, one for the mention and one for the follow-up:

```ts title="agent.test.ts"
import { expect, test } from "vitest";

test("a mention gets one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize the incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /summarize the incidents/ });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
});

test("follow-ups in the thread are answered without a new mention", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
  await expect(msg.thread).toHaveReplyFrom("my-agent");

  await ana.reply("and the API?", { thread: msg });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /and the API/ });
});
```

Run them:

```bash
npx vitest run
```

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Ana's follow-up has no mention. The fake sends it to the bot as a plain `message` event, and the Chat SDK hands it to `onSubscribedMessage` because the bot subscribed to that thread.

## 5. Break it on purpose

Remove the subscription:

```diff title="agent.ts"
 bot.onNewMention(async (thread, message) => {
   if (message.author.isBot === true) return;
-  await thread.subscribe();
   await thread.post(`On it: ${question(message.text)}`);
 });
```

Restart the bot and run the tests again. The first still passes; the second fails once its wait runs out:

```
 FAIL  agent.test.ts > follow-ups in the thread are answered without a new mention
Error: Expected a reply from my-agent matching /and the API/. The thread has:
  my-agent: On it: what's the status of the web deploy?
  Ana: and the API?
```

The bot still received Ana's follow-up, but without a subscription the Chat SDK has nothing to hand it to. Put `thread.subscribe()` back, restart the bot, and both tests pass.

## Other platforms

The Chat SDK's GitHub and Linear adapters work the same way: each reads its API URL from what `channelstack env` prints (`GITHUB_API_URL`, `LINEAR_API_URL`), or takes an `apiUrl` option. Give each adapter its own endpoint and tell the server about it when it starts. These are the paths the `chat-sdk-github` and `chat-sdk-linear` reference agents use:

| Adapter | Package | Endpoint | Server setting |
|---|---|---|---|
| Slack | `@chat-adapter/slack@4.45.0` | `/slack/events` | `CHANNELSTACK_SLACK_WEBHOOK_URL` |
| GitHub | `@chat-adapter/github@4.45.0` | `/api/webhooks/github` | `CHANNELSTACK_GITHUB_WEBHOOK_URL` |
| Linear | `@chat-adapter/linear@4.45.0` | `/api/webhooks/linear` | `CHANNELSTACK_LINEAR_WEBHOOK_URL` |

The server reads these once, when it starts, so restart it after adding one.

### GitHub

The GitHub adapter runs as the GitHub App `channelstack env` describes. `GITHUB_PRIVATE_KEY` comes as one line, with `\n` for its line breaks:

```ts title="github-agent.ts"
import { createGitHubAdapter } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

import { serve } from "./serve.ts";

const { GITHUB_APP_ID = "", GITHUB_PRIVATE_KEY = "", GITHUB_WEBHOOK_SECRET = "" } = process.env;

const github = createGitHubAdapter({
  appId: GITHUB_APP_ID,
  privateKey: GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
  webhookSecret: GITHUB_WEBHOOK_SECRET,
  userName: "my-agent",
});
const bot = new Chat({ userName: "my-agent", adapters: { github }, state: createMemoryState(), logger: "warn" });

bot.onNewMention(async (thread) => {
  await thread.post("Thanks, I'll triage this.");
});

serve(3001, "/api/webhooks/github", (request) => bot.webhooks.github(request));
```

```ts title="github-agent.test.ts"
import { expect, test } from "vitest";

test("a mention in an issue gets one comment", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
  const issue = await ana.openIssue({ title: "Login fails on Safari" }, { repo });

  await ana.comment("@my-agent can you triage this?", { issue });

  await expect(issue).toHaveCommentFrom(github.app, { text: /triage/i });
  await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
});
```

Start the server with `CHANNELSTACK_GITHUB_WEBHOOK_URL=http://127.0.0.1:3001/api/webhooks/github`. The [GitHub page](/docs/platforms/github) covers pull requests, reviews and check runs.

### Linear

The Linear adapter in `agent-sessions` mode turns a delegation or a mention into a new mention, and a post in that thread into the session's `response` activity. It reads `LINEAR_WEBHOOK_SECRET` and `LINEAR_API_URL` from the environment:

```ts title="linear-agent.ts"
import { createLinearAdapter } from "@chat-adapter/linear";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";

import { serve } from "./serve.ts";

const linear = createLinearAdapter({
  mode: "agent-sessions",
  accessToken: process.env.LINEAR_ACCESS_TOKEN ?? "",
  userName: "my-agent",
});
const bot = new Chat({ userName: "my-agent", adapters: { linear }, state: createMemoryState(), logger: "warn" });

bot.onNewMention(async (thread) => {
  await thread.post("I'm on it.");
});

serve(3002, "/api/webhooks/linear", (request) => bot.webhooks.linear(request));
```

```ts title="linear-agent.test.ts"
import { expect, test } from "vitest";

test("delegating an issue gets a response in its session", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });

  const session = await ana.delegate(linear.app, { issue });

  await expect(session).toHaveActivity({ type: "response" });
  await expect(issue).toBeDelegatedTo(linear.app);
});
```

Start the server with `CHANNELSTACK_LINEAR_WEBHOOK_URL=http://127.0.0.1:3002/api/webhooks/linear`. The reference agent also posts thoughts and moves the issue's state through its own `LinearClient`; the [Linear page](/docs/platforms/linear) shows what a test can check of those.

## Next steps

- [Connecting your agent](/docs/guide/connecting-your-agent): portless, HTTPS and TLS trust, and the other SDKs' base-URL options.
- [Standard checks](/docs/guide/standard-checks): add `slackChecks()` and the others to test retries, bad signatures and Stop without writing those tests yourself.
- [Slack](/docs/platforms/slack): buttons, modals, slash commands, streams and Stop, all of which the Chat SDK reference agent handles.
- [AI SDK](/docs/quickstarts/ai-sdk): stream a model's answer into Slack and test the stream.
