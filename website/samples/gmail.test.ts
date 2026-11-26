import { expect, test } from "vitest";

// @show:start
test("answers in Ana's thread, in her mailbox", async ({ google }) => {
  const ana = await google.createUser({ name: "Ana" });
  // [!step 1]
  const email = await ana.send({ to: [google.app], subject: "Invoice", text: "Can you resend the March invoice?" });

  // [!step 2]
  const answer = await ana.waitForEmail({ from: google.app });
  // [!step 3]
  expect(answer.subject).toBe("Re: Invoice");
  expect(answer.thread.id).toBe(email.thread.id);
  // [!step 4]
  await expect(email.thread).toHaveRepliesFrom(google.app, { count: 1 });
});
// @show:end
