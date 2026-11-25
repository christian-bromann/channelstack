// @show:start
import { expect, test } from "vitest";

test("a mention gets one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize the incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /summarize the incidents/ });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
  await expect(channel).not.toHaveChannelMessageFrom("my-agent");
});
// @show:end
