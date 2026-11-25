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

test("it ignores other bots", async ({ slack }) => {
  const deployBot = await slack.createUser({ name: "deploy-bot", bot: true });
  const channel = await slack.createChannel({ participants: [deployBot, slack.app] });

  const msg = await deployBot.say("@my-agent build #812 failed", { channel });

  await expect(msg.thread).not.toHaveReplyFrom("my-agent");
});
// @show:end
