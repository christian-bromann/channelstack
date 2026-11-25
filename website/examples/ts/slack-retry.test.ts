import { expect, test } from "vitest";

test("Slack's retry is answered once", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("@my-agent hi", { to: slack.app });
  // @show:start
  await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  // @show:end
});
