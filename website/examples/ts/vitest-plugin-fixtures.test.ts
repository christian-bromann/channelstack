// @show:start
import { expect, test } from "vitest";

test("answers in the thread", async ({ slack, channelstack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent hi", { channel });
  await expect(msg.thread).toHaveReplyFrom("my-agent");
  await channelstack.quiet();
});
// @show:end
