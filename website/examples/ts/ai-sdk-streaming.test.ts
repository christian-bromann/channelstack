// @show:start
import { expect, test } from "vitest";

/** What the model streams, a piece at a time. */
const notes = [
  "# Release notes for 0.10\n\n",
  "## What changed\n\nThe delivery queue now retries a slow acknowledgement the way the platform does.\n\n",
  "## What to do\n\nUpdate, run the tests once and read the new failure messages.\n\n",
  "## Thanks\n\nTo everyone who sent the transcript of a conversation that went wrong.\n",
];

test("streams a reply and shows a status while working", async ({ slack, openai }) => {
  await openai.respond({ text: notes }, { timing: { firstToken: "700ms", betweenChunks: "250ms" } });
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("write the release notes for 0.10", { to: slack.app });

  await expect(msg.thread).toHaveStatus("working");
  await expect(msg.thread).toHaveStatusText(/thinking/i);
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");
  await expect(msg.thread).toHaveStatus("idle");

  const reply = await msg.thread.latestReply({ from: "my-agent" });
  const stream = await reply.stream!.ended();
  expect(stream.state).toBe("completed");
  await expect(openai).toHaveSent(msg);
});

test("Stop ends the stream and cancels the model", async ({ slack, openai }) => {
  const ai = await openai.respond({ text: "More detail, for those who asked. ".repeat(40), pauseAfter: 3 });
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("write a long report on Q3", { to: slack.app });
  const call = await ai.waitForPause();
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

  await ana.stop({ thread: msg });

  await expect(msg.thread).toHaveStatus("stopped");
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(call).toBeAborted();
});
// @show:end
