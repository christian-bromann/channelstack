import { expect, test } from "vitest";

// Run by `../plugin-defaults.test.ts`, and meant to fail: no agent is in the channel, so the check
// waits its whole default timeout (10s) for a reply that never comes.
test("a check that fails after its own timeout", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana] });
  const message = await ana.say("@my-agent are you there?", { channel });

  await expect(message.thread).toHaveReplyFrom("my-agent");
});
