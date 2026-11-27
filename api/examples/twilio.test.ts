/**
 * Twilio examples: an agent people text. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos.
 */
import { describe, test, expect } from "vitest";

describe("text conversations", () => {
  test("a text to the agent gets one reply, back to the sender", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });

    const text = await ana.text("Where is my order?", { to: twilio.app });

    await expect(text.conversation).toHaveReplyFrom("my-agent", { text: /order/i });
    await expect(text.conversation).toHaveRepliesFrom(twilio.app, { count: 1 });
    const [answer] = await text.conversation.replies();
    expect(answer?.to).toBe(ana.number);
    expect(answer?.from).toBe(twilio.app.number);
  });

  test("the answer reaches the person's phone and is delivered", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("Where is my order?", { to: twilio.app });

    const answer = await ana.waitForMessage({ from: twilio.app });

    expect(answer.conversation.id).toBe(text.conversation.id);
    expect((await answer.refresh()).status).toBe("delivered");
  });

  test("a second text continues the conversation", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("Where is my order?", { to: twilio.app });
    await text.conversation.waitForReply({ from: twilio.app });

    await ana.text("And the invoice?", { to: twilio.app });

    const next = await text.conversation.waitForReply({ from: twilio.app, timeout: "10s" });
    expect(next.text).toMatch(/invoice/i);
    await expect(text.conversation).toHaveRepliesFrom(twilio.app, { count: 2 });
  });

  test("a long answer is sent in several segments", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("Tell me everything about my order", { to: twilio.app });

    const answer = await text.conversation.waitForReply({ from: twilio.app });

    expect(answer.text.length).toBeGreaterThan(160);
    expect(answer.segments).toBeGreaterThan(1);
  });

  test("a text between people doesn't reach the agent", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const ben = await twilio.createUser({ name: "Ben" });

    const text = await ana.text("Lunch?", { to: ben });

    expect(text.delivery).toBeUndefined();
    await expect(text.conversation).not.toHaveReplyFrom(twilio.app);
  });

  test("after STOP the agent can't text the person, and Twilio said so", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });

    const stop = await ana.text("STOP", { to: twilio.app });

    // The agent got the text as it was; Twilio answered it, and the agent didn't try to.
    expect(stop.delivery?.payload.Body).toBe("STOP");
    await expect(twilio).not.toHaveReceivedCall("messages.create");
    const transcript = await stop.conversation.transcript();
    expect(transcript.entries.at(-1)?.text).toMatch(/unsubscribed/);
  });
});

describe("delivery and failures (fake only)", () => {
  test("rejects a webhook with a bad signature", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("hello", { to: twilio.app });

    await text.delivery!.resend({ badSignature: true });

    await expect(text.delivery!).toBeRejected();
  });

  test("a webhook Twilio sends again doesn't produce a second answer", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("Where is my order?", { to: twilio.app });
    await expect(text.conversation).toHaveReplyFrom(twilio.app);

    // Twilio retries with the same MessageSid and I-Twilio-Idempotency-Token.
    await text.delivery!.redeliver();

    await expect(text.conversation).toHaveRepliesFrom(twilio.app, { count: 1 });
  });

  test("a text to a phone that's off ends undelivered", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana", reachable: false });
    const text = await ana.text("Where is my order?", { to: twilio.app });

    const answer = await text.conversation.waitForReply({ from: twilio.app });

    expect(answer.status).toBe("undelivered");
    expect(answer.errorCode).toBe(30003);
    expect(await ana.messages()).toEqual([]);
  });
});

describe("inspecting what the agent did", () => {
  test("it answered through the Messages API, and heard what became of it", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });
    const text = await ana.text("Where is my order?", { to: twilio.app });
    await expect(text.conversation).toHaveReplyFrom(twilio.app);

    await expect(twilio).toHaveReceivedCall("messages.create");
    expect(await twilio.calls({ error: true })).toEqual([]);
    const callbacks = await twilio.deliveries({ type: "status" });
    expect(callbacks.map((callback) => callback.payload.MessageStatus)).toContain("delivered");
  });
});

describe("live mode", () => {
  // With the agent's account (CHANNELSTACK_TWILIO_ACCOUNT_SID, _AUTH_TOKEN, _NUMBER) and Ana's
  // (CHANNELSTACK_TWILIO_USER_ANA_TOKEN, the account that owns her number) set, Ana's text goes
  // through real Twilio to the agent's number, and Twilio posts it to the agent itself.
  test.skipIf(!process.env.CHANNELSTACK_TWILIO_USER_ANA_TOKEN)("a real text gets a real answer", async ({ twilio }) => {
    const ana = await twilio.createUser({ name: "Ana" });

    const text = await ana.text("Where is my order?", { to: twilio.app });

    await expect(text.conversation).toHaveReplyFrom(twilio.app, { timeout: "60s" });
  });
});
