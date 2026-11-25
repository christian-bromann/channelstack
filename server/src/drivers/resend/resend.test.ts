import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { resendResponseProblems, resendWebhookProblems } from "../../../test/schemas/resend.ts";

/**
 * The Resend fake's API as an agent meets it: what it refuses as Resend does, what each test
 * address does, and that every answer and webhook is what Resend's description says (exit check 8.3).
 */
let agent: RecordingAgent | undefined;
afterEach(() => agent?.close());

async function team() {
  agent = await recordingAgent();
  const h = harness({ resend: agent.url });
  // Webhooks belong to a test's session: each email cc's a person in it, so it has one.
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const ana = (await h.call("POST", `/sessions/${sessionId}/resend/users`, { name: "Ana" })).body;
  const key = h.secrets.get("resend", "apiKey");
  const api = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    token: string | null = key,
  ) => h.provider(method, `resend${path}`, body, token, { "user-agent": "resend-node:test", ...headers });
  /** Send, and hold the answer to Resend's description. */
  const send = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const reply = await api("POST", "/emails", body, headers);
    expect(resendResponseProblems("POST", "/emails", reply.status, reply.body)).toEqual([]);
    return reply;
  };
  /** The webhooks delivered so far, each held to Resend's description. */
  const webhooks = async () => {
    await h.app.settled();
    const events = (agent as RecordingAgent).received.map((delivery) => JSON.parse(delivery.body));
    for (const event of events) expect(resendWebhookProblems(event.type, event)).toEqual([]);
    return events as Array<{ type: string; data: Record<string, unknown> }>;
  };
  /** An email from the agent, cc'ing Ana so it is the test's. */
  const email = (to: string | string[], extra: Record<string, unknown> = {}) => ({
    from: "my-agent <my-agent@acme.example>",
    to,
    cc: [ana.address],
    subject: "Hello",
    text: "Hi there",
    ...extra,
  });
  return { h, api, send, webhooks, email };
}

describe("what the Resend fake refuses, as Resend does", () => {
  test("no key, a wrong key", async () => {
    const { api, email } = await team();
    const none = await api("POST", "/emails", email("delivered@resend.dev"), {}, null);
    expect(none).toMatchObject({ status: 401, body: { name: "missing_api_key" } });
    const wrong = await api(
      "POST",
      "/emails",
      email("delivered@resend.dev"),
      {},
      "re_wrong123_abcdefghijklmnopqrstuvwx",
    );
    expect(wrong).toMatchObject({ status: 400, body: { statusCode: 400, name: "validation_error" } });
  });

  test("a domain the team hasn't verified, missing fields, too many recipients", async () => {
    const { api, webhooks, email } = await team();
    const unverified = await api("POST", "/emails", email("delivered@resend.dev", { from: "x@elsewhere.example" }));
    expect(unverified).toMatchObject({ status: 403, body: { name: "validation_error" } });
    expect(unverified.body.message).toContain("elsewhere.example domain is not verified");
    const { subject: _subject, ...noSubject } = email("delivered@resend.dev");
    expect(await api("POST", "/emails", noSubject)).toMatchObject({
      status: 422,
      body: { name: "missing_required_field" },
    });
    expect(await api("POST", "/emails", email("delivered@resend.dev", { text: undefined }))).toMatchObject({
      status: 422,
      body: { name: "validation_error" },
    });
    const many = Array.from({ length: 51 }, (_, at) => `delivered+${at}@resend.dev`);
    expect(await api("POST", "/emails", email(many))).toMatchObject({ status: 422 });
    // Nothing refused was sent.
    expect(await webhooks()).toEqual([]);
  });

  test("an idempotency key answers the same request the same, and refuses another one", async () => {
    const { send, api, email } = await team();
    const first = await send(email("delivered@resend.dev"), { "idempotency-key": "order-1" });
    const again = await send(email("delivered@resend.dev"), { "idempotency-key": "order-1" });
    expect(again.body).toEqual(first.body);
    const other = await api("POST", "/emails", email("bounced@resend.dev"), { "idempotency-key": "order-1" });
    expect(other).toMatchObject({ status: 409, body: { name: "invalid_idempotent_request" } });
  });

  test("over 10 requests a second nothing more is sent, and the agent may send the same again later", async () => {
    const { h, api, send, webhooks, email } = await team();
    for (let at = 0; at < 10; at++) await send(email(`delivered+${at}@resend.dev`));
    const sentBefore = (await webhooks()).filter((event) => event.type === "email.sent").length;
    const refused = await api("POST", "/emails", email("delivered+late@resend.dev"), { "idempotency-key": "late" });
    expect(refused).toMatchObject({ status: 429, body: { name: "rate_limit_exceeded" } });
    expect((await webhooks()).filter((event) => event.type === "email.sent").length).toBe(sentBefore);
    // A second later, the same request with the same key goes through: the 429 didn't use the key up.
    h.clock.advance(1_100);
    expect((await send(email("delivered+late@resend.dev"), { "idempotency-key": "late" })).status).toBe(200);
  });

  test("a batch is checked whole: one bad email and none is sent", async () => {
    const { api, webhooks, email } = await team();
    const batch = [email("delivered@resend.dev"), email("delivered@resend.dev", { from: "x@elsewhere.example" })];
    expect((await api("POST", "/emails/batch", batch)).status).toBe(403);
    expect(await webhooks()).toEqual([]);
  });
});

describe("Resend's test addresses do what they are for", () => {
  test.each([
    ["delivered@resend.dev", ["email.sent", "email.delivered"], "delivered"],
    ["delivered+label@resend.dev", ["email.sent", "email.delivered"], "delivered"],
    ["bounced@resend.dev", ["email.sent", "email.bounced"], "bounced"],
    ["complained@resend.dev", ["email.sent", "email.delivered", "email.complained"], "complained"],
    ["suppressed@resend.dev", ["email.sent", "email.suppressed"], "suppressed"],
  ])("%s: %j, last_event %s", async (to, events, last) => {
    const { api, send, webhooks, email } = await team();
    const { body } = await send(email(to));
    expect((await webhooks()).map((event) => event.type)).toEqual(events);
    const read = await api("GET", `/emails/${body.id}`);
    expect(read.body.last_event).toBe(last);
    expect(resendResponseProblems("GET", `/emails/${body.id}`, read.status, read.body)).toEqual([]);
    const list = await api("GET", "/emails");
    expect(resendResponseProblems("GET", "/emails", list.status, list.body)).toEqual([]);
  });

  test("an HTML-only email reads back without a text body, and the list fits Resend's description", async () => {
    const { api, send, email } = await team();
    const { body } = await send(email("delivered@resend.dev", { text: undefined, html: "<p>Hi</p>" }));
    const read = await api("GET", `/emails/${body.id}`);
    expect(read.body).not.toHaveProperty("text");
    expect(resendResponseProblems("GET", `/emails/${body.id}`, read.status, read.body)).toEqual([]);
  });
});
