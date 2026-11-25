import { expect, test } from "vitest";

// Run by `../plugin-defaults.test.ts`, with the plugin's `timeout: "1s"`. No agent is in the channel,
// so nothing ever answers: each SDK wait gives up after the plugin's timeout, not the SDK's own 10s.
test("the plugin's timeout is the SDK waits' default", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana] });
  const message = await ana.say("@my-agent are you there?", { channel });

  await expect(message.thread.waitForReply()).rejects.toThrow("Timed out after 1000ms waiting for a reply");
  await expect(channel.waitForMessage({ from: "my-agent" })).rejects.toThrow(
    "Timed out after 1000ms waiting for a message from my-agent",
  );
});
