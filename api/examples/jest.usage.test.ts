test("jest globals", async () => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent hi", { channel });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(channelstack.env()).resolves.toBeDefined();
});
export {};
