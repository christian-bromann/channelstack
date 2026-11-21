# channelstack

A test harness for AI agents that live in Slack, GitHub, Linear and Notion.

channelstack runs fake versions of those platforms on your machine. Tests script the people, your agent answers through its real code path, and you assert on the conversation a person would see:

```ts
test("a mention gets exactly one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
});
```

Website: [channelstack.dev](https://channelstack.dev)

**Status:** design complete, implementation not started. See [docs/phases.md](docs/phases.md).

## Documentation

- [AGENTS.md](AGENTS.md): start here if you're implementing channelstack
- [docs/devx.md](docs/devx.md): how it's used
- [docs/architecture.md](docs/architecture.md): how it works
- [docs/phases.md](docs/phases.md): the build plan and how each phase is verified
- [api/](api/): the public TypeScript API and examples
