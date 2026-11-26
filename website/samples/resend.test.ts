import { expect, test } from "vitest";

// @show:start
test("answers an email once, even when Resend retries", async ({ resend }) => {
  const ana = await resend.createUser({ name: "Ana" });
  // [!step 1]
  const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund for #4411?" });

  // [!step 2]
  await expect(email.thread).toHaveReplyFrom("my-agent", { text: /refund/i });

  // Resend delivers the webhook again, with the same svix-id
  // [!step 3]
  await email.delivery!.redeliver();
  // [!step 4]
  await expect(email.thread).toHaveRepliesFrom(resend.app, { count: 1 });
});
// @show:end
