// @show:start
import { expect, test } from "vitest";

test("streams a reply and shows a status while working", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("write the release notes for 0.10", { to: slack.app });

  await expect(msg.thread).toHaveStatus("working");
  await expect(msg.thread).toHaveStatusText(/thinking/i);
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");
  await expect(msg.thread).toHaveStatus("idle");

  const reply = await msg.thread.latestReply({ from: "my-agent" });
  const stream = await reply.stream!.ended();
  expect(stream.state).toBe("completed");
});

test("Stop ends the stream and the agent stays quiet", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("write a long report on Q3", { to: slack.app });
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

  await ana.stop({ thread: msg });

  await expect(msg.thread).toHaveStatus("stopped");
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});
// @show:end
