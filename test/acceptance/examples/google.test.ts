/**
 * Google examples: an agent people email at its Gmail address. Every test runs against the
 * in-memory fake by default. Tests marked "fake only" use delivery chaos.
 */
import { describe, expect, test } from "vitest";

describe("email conversations", () => {
  test("an email to the agent gets one reply, in its thread", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });

    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });

    await expect(email.thread).toHaveReplyFrom("my-agent", { text: /refund/i });
    await expect(email.thread).toHaveRepliesFrom(google.app, { count: 1 });
  });

  test("the answer reaches the person's mailbox, in the same thread", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });

    const answer = await ana.waitForEmail({ from: google.app });

    expect(answer.subject).toBe("Re: Refund");
    expect(answer.thread.id).toBe(email.thread.id);
    expect(answer.to).toEqual([ana.address]);
  });

  test("a reply in the thread continues the conversation", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });
    const answer = await email.thread.waitForReply({ from: google.app });

    await ana.reply(answer, { text: "Thanks. And where is the invoice?" });

    const next = await email.thread.waitForReply({ from: google.app });
    expect(next.text).toMatch(/invoice/i);
    await expect(email.thread).toHaveRepliesFrom(google.app, { count: 2 });
  });

  test("two emails at once are both answered", async ({ google }) => {
    // Gmail pushes at most once a second per mailbox: the agent reads every change since its last push.
    const ana = await google.createUser({ name: "Ana" });
    const ben = await google.createUser({ name: "Ben" });

    const first = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });
    const second = await ben.send({ to: [google.app], subject: "Invoice", text: "Where is my invoice?" });

    await expect(first.thread).toHaveRepliesFrom(google.app, { count: 1 });
    await expect(second.thread).toHaveRepliesFrom(google.app, { count: 1 });
  });

  test("the agent marks what it answered as read", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });
    await expect(email.thread).toHaveReplyFrom(google.app);

    // The agent may mark it read after it answers: read the labels until UNREAD is gone, for a
    // fixed 10 s (expect.poll's own default is 1 s, and live reads are cached for a second).
    // INBOX first: live, the labels are empty until the agent's copy is found.
    const labels = async () => (await email.refresh()).labels;
    await expect.poll(labels, { timeout: 10_000 }).toContain("INBOX");
    await expect.poll(labels, { timeout: 10_000 }).not.toContain("UNREAD");
  });

  test("an email between people doesn't reach the agent", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const ben = await google.createUser({ name: "Ben" });

    const email = await ana.send({ to: [ben], subject: "Lunch?", text: "Noon?" });

    expect(email.delivery).toBeUndefined();
    await expect(email.thread).not.toHaveReplyFrom(google.app);
  });
});

describe("delivery and failures (fake only)", () => {
  test("rejects a push signed by another key", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Hi", text: "hello" });

    await email.delivery!.resend({ badSignature: true });

    await expect(email.delivery!).toBeRejected();
  });

  test("rejects a push whose token is for another audience", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Hi", text: "hello" });

    await email.delivery!.resend({ wrongAudience: true });

    await expect(email.delivery!).toBeRejected();
  });

  test("rejects a push whose token has expired", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Hi", text: "hello" });

    await email.delivery!.resend({ stale: true });

    await expect(email.delivery!).toBeRejected();
  });

  test("a push sent again doesn't produce a second answer", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });
    await expect(email.thread).toHaveReplyFrom(google.app);

    // Pub/Sub delivers at least once: the same message id again.
    await email.delivery!.redeliver();

    await expect(email.thread).toHaveRepliesFrom(google.app, { count: 1 });
  });
});

describe("inspecting what the agent did", () => {
  test("it read its history and the email, and sent its answer", async ({ google }) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "Refund", text: "Where is my refund?" });
    await expect(email.thread).toHaveReplyFrom(google.app);

    await expect(google).toHaveReceivedCall("users.history.list");
    await expect(google).toHaveReceivedCall("users.messages.get");
    await expect(google).toHaveReceivedCall("users.messages.send");
    expect(await google.calls({ error: true })).toEqual([]);
    const pushes = await google.deliveries({ type: "gmail.history" });
    expect(pushes.length).toBeGreaterThan(0);
  });
});

describe("live mode", () => {
  // With the agent's OAuth client and refresh token, and CHANNELSTACK_GOOGLE_USER_ANA_TOKEN (Ana's
  // own Gmail account's refresh token) set, Ana's email goes through real Gmail to the agent's
  // mailbox, and Gmail tells the agent through its own Pub/Sub topic.
  test.skipIf(!process.env.CHANNELSTACK_GOOGLE_USER_ANA_TOKEN)(
    "a real email gets a real answer",
    async ({ google }) => {
      const ana = await google.createUser({ name: "Ana" });

      const email = await ana.send({ to: [google.app], subject: "Live smoke test", text: "Where is my refund?" });

      await expect(email.thread).toHaveReplyFrom(google.app, { timeout: "90s" });
    },
  );
});
