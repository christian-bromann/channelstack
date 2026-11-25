import { expect, test } from "vitest";

// @show:start
test("still answers when Slack refuses a message as too long", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  await using _fault = await slack.fault({
    type: "error",
    operation: "chat.postMessage",
    error: "msg_too_long",
    times: 1,
  });

  const msg = await ana.say("@my-agent hello", { channel });

  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});
// @show:end
