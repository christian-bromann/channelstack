import { expect, test } from "vitest";

// Two waits with different filters on one fixture: each keeps its own place, so the second one
// finds a call that was already there when the first one returned.
test("waitForCall with one filter doesn't hide calls from a wait with another", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent look at this", { channel });
  await expect(msg.thread).toHaveReplyFrom("my-agent");

  const post = await slack.waitForCall({ operation: "chat.postMessage" });
  const reaction = await slack.waitForCall({ operation: "reactions.add" }, { timeout: "2s" });
  expect([post.operation, reaction.operation]).toEqual(["chat.postMessage", "reactions.add"]);
});
