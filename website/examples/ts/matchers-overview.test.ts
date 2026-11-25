import { expect, test } from "vitest";

test("three matchers", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });
  // @show:start
  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /incident/i });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
  // @show:end
});
