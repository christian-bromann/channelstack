import { expect, test } from "vitest";

// @show:start
test("survives Slack's retry", async ({ slack, skip }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("@my-agent hello", { to: slack.app });
  const delivery = msg.delivery ?? skip("live: the platform delivers to the agent itself");
  await delivery.retry({ after: "3s", reason: "http_timeout" });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
});
// @show:end
