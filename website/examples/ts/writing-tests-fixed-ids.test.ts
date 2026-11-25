import { expect, test } from "vitest";

// @show:start
test("allowlisted people by fixed id", async ({ slack }) => {
  const admin = await slack.createUser({ name: "Cara", id: "U0ADMIN01" });
  const stranger = await slack.createUser({ name: "Dev" });
  const channel = await slack.createChannel({ participants: [admin, stranger, slack.app] });

  const allowed = await admin.say("@my-agent rotate the API keys", { channel });
  const refused = await stranger.say("@my-agent rotate the API keys", { channel });

  await expect(allowed.thread).toHaveReplyFrom("my-agent", { text: /rotating/i });
  await expect(refused.thread).toHaveReplyFrom("my-agent", { text: /not allowed/i });
});
// @show:end
