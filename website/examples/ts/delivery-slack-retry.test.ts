import { expect, test } from "vitest";

// @show:start
test("survives Slack's 3s retry without answering twice", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent hi", { channel });

  await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });

  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});
// @show:end
