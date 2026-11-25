import { expect, test } from "vitest";

// @show:start
test("reconnects after the Socket Mode connection drops", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  await slack.fault({ type: "drop_socket" });

  const msg = await ana.say("still there?", { to: slack.app });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { timeout: "20s" });
});
// @show:end
