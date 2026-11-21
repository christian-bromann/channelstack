import { test, expect } from "vitest";

// @show:start
// with CHANNELSTACK_SLACK_BOT_TOKEN and
// CHANNELSTACK_SLACK_USER_ANA_TOKEN set, Ana is a real person
test("a real person asks the real agent", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] }); // [!step 1]

  const msg = await ana.say("@robin summarize #support today", { channel }); // [!step 2]
  await expect(msg.thread).toHaveReplyFrom("robin", { timeout: "30s" }); // [!step 3]
});
// @show:end
