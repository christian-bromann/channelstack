// @show:start
import { expect, test } from "vitest";

test("approval buttons act once, even on a double click", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const msg = await ana.say("@my-agent deploy web to staging", { channel });

  const ask = await msg.thread.latestReply({ from: "my-agent" });
  await expect(ask).toHaveButton("Approve");

  await ben.click("Approve", { message: ask });
  await ben.click("Approve", { message: ask });

  await expect(msg.thread).toContainText("Deploying", { count: 1 });
  await expect(slack).not.toHaveReceivedCall(/.*/, { error: "not_in_channel" });
});
// @show:end
