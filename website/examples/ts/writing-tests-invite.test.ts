import { expect, test } from "vitest";

// @show:start
test("a channel the app isn't in stays silent until it's invited", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana", admin: true });
  const channel = await slack.createChannel({ participants: [ana] });

  const first = await ana.say("@my-agent are you here?", { channel });
  await expect(first.thread).not.toHaveReplyFrom("my-agent");

  await ana.invite(slack.app, { channel });
  const second = await ana.say("@my-agent now?", { channel });
  await expect(second.thread).toHaveReplyFrom("my-agent");
});
// @show:end
