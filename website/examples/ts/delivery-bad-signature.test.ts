import { expect, test } from "vitest";

// @show:start
test("rejects a bad signature and a stale timestamp", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("hi", { to: slack.app });

  await msg.delivery!.resend({ badSignature: true });
  await expect(msg.delivery!).toBeRejected();

  await msg.delivery!.resend({ stale: true });
  await expect(msg.delivery!).toBeRejected();
});
// @show:end
