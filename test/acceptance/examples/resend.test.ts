/**
 * Resend examples: an agent people email. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos.
 */
import { describe, expect, test } from "vitest";

describe("email conversations", () => {
  test("an email to the agent gets one reply, in its thread", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });

    const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund?" });

    await expect(email.thread).toHaveReplyFrom("my-agent", { text: /refund/i });
    await expect(email.thread).toHaveRepliesFrom(resend.app, { count: 1 });
  });

  test("the answer reaches the person's mailbox, in the same thread", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund?" });

    const answer = await ana.waitForEmail({ from: resend.app });

    expect(answer.subject).toBe("Re: Refund");
    expect(answer.thread.id).toBe(email.thread.id);
    expect(answer.to).toEqual([ana.address]);
  });

  test("a reply in the thread continues the conversation", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund?" });
    const answer = await email.thread.waitForReply({ from: resend.app });

    await ana.reply(answer, { text: "Thanks. And where is the invoice?" });

    const next = await email.thread.waitForReply({ from: resend.app });
    expect(next.text).toMatch(/invoice/i);
    await expect(email.thread).toHaveRepliesFrom(resend.app, { count: 2 });
  });

  test("an email between people doesn't reach the agent", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const ben = await resend.createUser({ name: "Ben" });

    const email = await ana.send({ to: [ben], subject: "Lunch?", text: "Noon?" });

    expect(email.delivery).toBeUndefined();
    await expect(email.thread).not.toHaveReplyFrom(resend.app);
  });
});

describe("delivery and failures (fake only)", () => {
  test("rejects a webhook with a bad signature", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Hi", text: "hello" });

    await email.delivery!.resend({ badSignature: true });

    await expect(email.delivery!).toBeRejected();
  });

  test("rejects a webhook signed more than five minutes ago", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Hi", text: "hello" });

    await email.delivery!.resend({ stale: true });

    await expect(email.delivery!).toBeRejected();
  });

  test("a redelivered email doesn't produce a second answer", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund?" });
    await expect(email.thread).toHaveReplyFrom(resend.app);

    // Resend retries with the same svix-id and email_id.
    await email.delivery!.redeliver();

    await expect(email.thread).toHaveRepliesFrom(resend.app, { count: 1 });
  });
});

describe("inspecting what the agent did", () => {
  test("it read the email back and sent its answer", async ({ resend }) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "Refund", text: "Where is my refund?" });
    await expect(email.thread).toHaveReplyFrom(resend.app);

    await expect(resend).toHaveReceivedCall("emails.receiving.get");
    await expect(resend).toHaveReceivedCall("emails.send");
    expect(await resend.calls({ error: true })).toEqual([]);
    const sent = await resend.deliveries({ type: "email.sent" });
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("several apps", () => {
  // Decision 0027: the same agent runs a second time as the app `coder`, with its own mailbox, key and webhook.
  test("an email to one app is answered by that app alone, marked as sent by a program", async ({ resend }) => {
    const coder = await resend.createApp({ name: "coder" });
    const ana = await resend.createUser({ name: "Ana" });

    const email = await ana.send({ to: [coder], subject: "Refund", text: "Where is my refund?" });

    const answer = await ana.waitForEmail({ from: coder });
    expect(answer.thread.id).toBe(email.thread.id);
    expect(answer.headers["auto-submitted"]).toBe("auto-replied");
    await expect(email.thread).not.toHaveReplyFrom(resend.app);
  });

  test("mail another program sent on its own gets no answer, so two agents don't answer each other", async ({
    resend,
  }) => {
    const billing = await resend.createApp({ name: "billing" });

    const email = await billing.send({
      to: [resend.app],
      subject: "Invoice 1042 paid",
      text: "Invoice 1042 was paid.",
      headers: { "Auto-Submitted": "auto-generated" },
    });

    await expect(email.thread).toGoQuiet({ within: "10s", maxReplies: 1 });
    await expect(email.thread).not.toHaveReplyFrom(resend.app);
  });
});

describe("live mode", () => {
  // With the agent team's key and CHANNELSTACK_RESEND_USER_ANA_TOKEN (Ana's own team's key) set,
  // Ana's email goes through real Resend to the agent's receiving address, and Resend delivers to
  // the agent itself.
  test.skipIf(!process.env.CHANNELSTACK_RESEND_USER_ANA_TOKEN)(
    "a real email gets a real answer",
    async ({ resend }) => {
      const ana = await resend.createUser({ name: "Ana" });

      const email = await ana.send({ to: [resend.app], subject: "Live smoke test", text: "Where is my refund?" });

      await expect(email.thread).toHaveReplyFrom(resend.app, { timeout: "60s" });
    },
  );
});
