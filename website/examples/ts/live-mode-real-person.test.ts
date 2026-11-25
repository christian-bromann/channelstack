import { expect, test } from "vitest";

// @show:start
test("a real person asks the real agent", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const msg = await ana.say("@my-agent summarize #support today", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { timeout: "30s" });
});
// @show:end
