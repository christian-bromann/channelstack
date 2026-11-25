import { expect, test } from "vitest";

test("matchers wait in two ways", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  // @show:start
  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent"); // waits for a reply
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 }); // waits for quiet, then counts
  await expect(channel).not.toHaveChannelMessageFrom("my-agent"); // waits for quiet, then checks
  // @show:end
});
