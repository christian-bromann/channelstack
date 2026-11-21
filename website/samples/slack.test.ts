import { test, expect } from "vitest";

// @show:start
test("a mention gets exactly one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@robin summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("robin", { text: /incident/i });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("robin");
});
// @show:end
