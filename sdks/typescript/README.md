# channelstack

A test harness for the apps and agents you build for Slack, GitHub, Linear, Notion, Resend, Gmail and Discord. channelstack runs fake versions of those platforms on your machine. Your tests script the people, your app answers through its real code path, and you check what a person would see.

This package has the `channelstack` CLI and server, the TypeScript SDK, the Vitest plugin (`channelstack/vitest`) and the standard behaviour checks (`channelstack/checks`). The server binary for your platform comes with it, as an optional dependency (`@channelstack/server-<platform>-<arch>`).

## Install

```bash
npm i -D channelstack
```

It needs Node 22 or later.

## A first test

```ts
import { expect, test } from "vitest";

test("a mention gets one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize the incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /summarize the incidents/ });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
});
```

Start the server with `npx channelstack`, point your app at the fake platforms with `npx channelstack env`, and add the plugin to your Vitest config. [Getting started](https://channelstack.dev/docs/getting-started) walks through it.

## Without a test framework

```ts
import { connect } from "channelstack/client";

await using client = await connect({ mode: "auto" });
await using session = await client.openSession({ name: "example" });

const slack = await session.slack();
const ana = await slack.createUser({ name: "Ana" });
const channel = await slack.createChannel({ participants: [ana, slack.app] });

const msg = await ana.say("@my-agent hi", { channel });
const reply = await msg.thread.waitForReply({ from: "my-agent" });
console.log(reply.text);
```

## Links

- [Documentation](https://channelstack.dev/docs)
- [The SDKs](https://channelstack.dev/docs/reference/sdks), also for [Python](https://pypi.org/project/channelstack/) and [Rust](https://crates.io/crates/channelstack)
- [Source, issues and changelog](https://github.com/christian-bromann/channelstack)

MIT licensed.
