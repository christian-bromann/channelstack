---
title: "Pi"
order: 4
description: "Embed the Pi coding agent in a Slack bot with its SDK, give it a scripted model with pi-ai's faux provider, and test it against the fake Slack."
---

# Pi

In this tutorial you put [Pi](https://github.com/earendil-works/pi), the coding agent, in Slack: a Bolt app hands each mention to a Pi session through Pi's SDK and posts Pi's answer in the thread. Pi runs on pi-ai's faux provider, a scripted model, so every run gives the same answer. Then you test it against channelstack's fake Slack and break it once.

[Getting started](/docs/getting-started) explains the server, `channelstack env` and a first test in more detail. This page builds on it.

> [!NOTE]
> channelstack's CI has no Pi reference agent yet. The Bolt side of this page is the one the `bolt-ai-sdk` reference agent runs. The Pi side (`createAgentSession` with the faux provider) follows Pi's SDK and Pi's own tests at version 1.6.0. These steps pass against channelstack as written, but CI doesn't run them, so a newer Pi may need changes.

## 1. Create the project

You need Node.js 24 or newer, which runs the TypeScript files below as they are.

```bash
mkdir pi-agent && cd pi-agent
npm init -y
npm pkg set type=module
npm i @slack/bolt@5.1.0 @earendil-works/pi-coding-agent@1.6.0 @earendil-works/pi-ai@1.6.0
npm i -D channelstack vitest
```

Pi's packages used to be published as `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`. Those names are deprecated; the `@earendil-works` ones are the current releases.

## 2. Start channelstack

In a second terminal:

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events \
  npx channelstack start --no-portless --port 4500
```

In the first terminal:

```bash
npx channelstack env > .env.local
```

## 3. A scripted model

pi-ai's faux provider is a model that answers with whatever you queue for it, in order, and streams it like a real one. Pi's own tests register it this way:

```ts title="model.ts"
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const faux = registerFauxProvider();
export const model = faux.getModel();

/** Pi's model runtime, with the faux provider as one more provider and a key it accepts. */
export const modelRuntime = await ModelRuntime.create({ modelsPath: null });
modelRuntime.registerProvider(model.provider, {
  baseUrl: model.baseUrl,
  api: model.api,
  models: [
    {
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      baseUrl: model.baseUrl,
    },
  ],
});
await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");

/** Queue the model's next answer. */
export const answerNext = (text: string) => faux.appendResponses([fauxAssistantMessage(text)]);
```

In production you pick a real model from `ModelRuntime` instead (`modelRuntime.getModel("anthropic", …)`), with its API key, and drop `answerNext`.

## 4. Write the agent

The agent keeps one Pi session per Slack thread, so a thread is one conversation with Pi. It turns off Pi's tools (`noTools: "all"`): a bot that answers anyone in a channel shouldn't run shell commands for them.

```ts title="agent.ts"
import { App } from "@slack/bolt";
import { type AgentSession, createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { answerNext, model, modelRuntime } from "./model.ts";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Unset in production, so the agent talks to Slack itself.
  clientOptions: process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {},
});

/** One Pi session per thread, in memory. */
const sessions = new Map<string, AgentSession>();

async function sessionFor(thread: string): Promise<AgentSession> {
  const existing = sessions.get(thread);
  if (existing) return existing;
  const { session } = await createAgentSession({
    model,
    modelRuntime,
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  sessions.set(thread, session);
  return session;
}

app.event("app_mention", async ({ event, say }) => {
  // Other bots don't get answers.
  if ("bot_id" in event) return;
  const thread = event.thread_ts ?? event.ts;
  const question = event.text.replace(/<@[^>]+>\s*/, "");
  const session = await sessionFor(`${event.channel}:${thread}`);

  answerNext(`On it: ${question}`);
  await session.prompt(question);
  await say({ text: session.getLastAssistantText() ?? "", thread_ts: thread });
});

await app.start(3000);
console.log("⚡️ Bolt app is running");
```

`session.prompt` resolves when Pi's run has finished, and `getLastAssistantText` is its answer. Start the agent in a third terminal:

```bash
node --env-file=.env.local agent.ts
```

## 5. Write the tests

Add the Vitest plugin:

```ts title="vitest.config.ts"
import channelstack from "channelstack/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [channelstack()],
  test: { testTimeout: 30_000 },
});
```

`testTimeout` keeps Vitest's own limit above the 10 seconds a channelstack check waits, so a failing check can say what went wrong before Vitest stops the test.

And two tests: a person's mention gets one answer in the thread, and another bot's mention gets none:

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

test("it ignores other bots", async ({ slack }) => {
  const deployBot = await slack.createUser({ name: "deploy-bot", bot: true });
  const channel = await slack.createChannel({ participants: [deployBot, slack.app] });

  const msg = await deployBot.say("@my-agent build #812 failed", { channel });

  await expect(msg.thread).not.toHaveReplyFrom("my-agent");
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

The second test is a negative check: it passes only after it has watched the agent stay quiet for a while, not the moment it starts. [Waiting and quiet](/docs/guide/waiting-and-quiet) explains how long, and why.

## 6. Break it on purpose

An agent backed by a model that answers other bots can run up a bill, or end up in a loop with another bot. Remove the guard:

```diff title="agent.ts"
-  // Other bots don't get answers.
-  if ("bot_id" in event) return;
```

Restart the agent and run the tests again:

```
 FAIL  agent.test.ts > it ignores other bots
Error: Expected no reply from my-agent. The thread has:
  my-agent: On it: build #812 failed
```

Put the guard back, restart the agent, and both tests pass.

## Next steps

- [Slack](/docs/platforms/slack): what else a Slack test can do, from buttons and modals to streams and Stop.
- [AI SDK](/docs/quickstarts/ai-sdk): stream a model's answer into Slack and test the stream, the status line and Stop.
- [Proxy mode](/docs/guide/proxy-mode): agents that hard-code `slack.com` and take no base URL.
- [pytest](/docs/guide/pytest): the same tests from Python.
