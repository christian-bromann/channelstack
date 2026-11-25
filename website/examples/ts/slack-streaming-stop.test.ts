import { expect, test } from "vitest";

test("a streaming reply, and Stop", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  // @show:start
  const msg = await ana.say("write a long report on Q3", { to: slack.app });
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

  await ana.stop({ thread: msg });
  await expect(msg.thread).toHaveStatus("stopped");
  // @show:end
});
