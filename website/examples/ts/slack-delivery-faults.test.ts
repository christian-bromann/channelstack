import { test } from "vitest";

test("Slack's delivery specifics", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("hi", { to: slack.app });
  // @show:start
  await slack.uninstallApp(); // app_uninstalled and tokens_revoked
  await slack.fault({ type: "rate_limit", operation: "chat.postMessage", retryAfter: "1s", times: 1 });
  await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });
  // @show:end
});
