import { expect, test } from "vitest";

// @show:start
test("answers a mention once, quoting it", async ({ discord }) => {
  const ana = await discord.createUser({ name: "Ana" });
  const channel = await discord.createChannel({ name: "support", participants: [ana, discord.app] });
  // [!step 1]
  const msg = await ana.say("@my-agent why is the build red?", { channel });

  // [!step 2]
  const answer = await msg.waitForReply({ from: "my-agent" });
  // [!step 3]
  expect(answer.replyTo).toBe(msg.id);
  // [!step 4]
  await expect(msg).toHaveRepliesFrom("my-agent", { count: 1 });
});
// @show:end
