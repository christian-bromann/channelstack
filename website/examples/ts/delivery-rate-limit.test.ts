import { expect, test } from "vitest";

// @show:start
test("backs off on rate limits and still answers", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const fault = await slack.fault({ type: "rate_limit", operation: "chat.postMessage", retryAfter: "1s", times: 1 });

  const msg = await ana.say("hi", { to: slack.app });

  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(slack).toHaveReceivedCall("chat.postMessage", { times: 2 });
  await fault.undo();
});
// @show:end
