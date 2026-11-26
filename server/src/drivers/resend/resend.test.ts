import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { resendResponseProblems, resendWebhookProblems } from "../../../test/schemas/resend.ts";

/**
 * The Resend fake's API as an agent meets it: what it refuses as Resend does, what each test
 * address does, and that every answer and webhook is what Resend's description says (exit check 8.3).
 */
let agent: RecordingAgent | undefined;

/**
 * Resend's refusal: `{ statusCode, name, message }` and nothing else, as its errors page shows.
 * Its API description has no schema for an error, so this is what holds the fake's to Resend's.
 */
function expectRefusal(reply: { status: number; body: Record<string, unknown> }, status: number, name: string) {
  expect(reply.status).toBe(status);
  expect(Object.keys(reply.body).sort()).toEqual(["message", "name", "statusCode"]);
  expect(reply.body).toMatchObject({ statusCode: status, name, message: expect.any(String) });
}
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
  /** Call, and hold a successful answer to Resend's description. */
  const read = async (method: string, path: string, body?: unknown) => {
    const reply = await api(method, path, body);
    expect(reply.status, JSON.stringify(reply.body)).toBeLessThan(400);
    expect(resendResponseProblems(method, path.split("?")[0] ?? path, reply.status, reply.body)).toEqual([]);
    return reply.body;
  };
  return { h, api, send, webhooks, email, read, sessionId, ana };
}

describe("what the Resend fake refuses, as Resend does", () => {
  test("no key, a wrong key", async () => {
    const { api, email } = await team();
    const none = await api("POST", "/emails", email("delivered@resend.dev"), {}, null);
    expectRefusal(none, 401, "missing_api_key");
    const wrong = await api(
      "POST",
      "/emails",
      email("delivered@resend.dev"),
      {},
      "re_wrong123_abcdefghijklmnopqrstuvwx",
    );
    expectRefusal(wrong, 400, "validation_error");
  });

  test("a domain the team hasn't verified, missing fields, too many recipients", async () => {
    const { api, webhooks, email } = await team();
    const unverified = await api("POST", "/emails", email("delivered@resend.dev", { from: "x@elsewhere.example" }));
    expectRefusal(unverified, 403, "validation_error");
    expect(unverified.body.message).toContain("elsewhere.example domain is not verified");
    const { subject: _subject, ...noSubject } = email("delivered@resend.dev");
    expectRefusal(await api("POST", "/emails", noSubject), 422, "missing_required_field");
    expectRefusal(
      await api("POST", "/emails", email("delivered@resend.dev", { text: undefined })),
      422,
      "validation_error",
    );
    const many = Array.from({ length: 51 }, (_, at) => `delivered+${at}@resend.dev`);
    expectRefusal(await api("POST", "/emails", email(many)), 422, "validation_error");
    // Nothing refused was sent.
    expect(await webhooks()).toEqual([]);
  });

  test("an idempotency key answers the same request the same, and refuses another one", async () => {
    const { send, api, email } = await team();
    const first = await send(email("delivered@resend.dev"), { "idempotency-key": "order-1" });
    const again = await send(email("delivered@resend.dev"), { "idempotency-key": "order-1" });
    expect(again.body).toEqual(first.body);
    const other = await api("POST", "/emails", email("bounced@resend.dev"), { "idempotency-key": "order-1" });
    expectRefusal(other, 409, "invalid_idempotent_request");
  });

  test("over 10 requests a second nothing more is sent, and the agent may send the same again later", async () => {
    const { h, api, send, webhooks, email } = await team();
    for (let at = 0; at < 10; at++) await send(email(`delivered+${at}@resend.dev`));
    const sentBefore = (await webhooks()).filter((event) => event.type === "email.sent").length;
    const refused = await api("POST", "/emails", email("delivered+late@resend.dev"), { "idempotency-key": "late" });
    expectRefusal(refused, 429, "rate_limit_exceeded");
    expect((await webhooks()).filter((event) => event.type === "email.sent").length).toBe(sentBefore);
    // A second later, the same request with the same key goes through: the 429 didn't use the key up.
    h.clock.advance(1_100);
    expect((await send(email("delivered+late@resend.dev"), { "idempotency-key": "late" })).status).toBe(200);
  });

  test("a batch is checked whole: one bad email and none is sent", async () => {
    const { api, webhooks, email } = await team();
    const batch = [email("delivered@resend.dev"), email("delivered@resend.dev", { from: "x@elsewhere.example" })];
    expectRefusal(await api("POST", "/emails/batch", batch), 403, "validation_error");
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

describe("what the fake answers fits Resend's description", () => {
  test("a batch that is sent, the domains, and mail a person sent the agent with its attachments", async () => {
    const { h, read, email, sessionId, ana } = await team();
    const sent = await read("POST", "/emails/batch", [email("delivered@resend.dev"), email("bounced@resend.dev")]);
    expect(sent.data).toHaveLength(2);
    const domains = await read("GET", "/domains");
    expect(domains.data[0]).toMatchObject({ name: "acme.example", status: "verified" });

    const { app } = (await h.call("GET", `/sessions/${sessionId}/resend`)).body;
    const user = `/sessions/${sessionId}/resend/users/${encodeURIComponent(ana.id)}`;
    await h.call("POST", `${user}/send`, { to: [app.id], subject: "Refund", text: "Where is my refund?" });
    const received = await read("GET", "/emails/receiving?limit=10");
    expect(received.data).toHaveLength(1);
    const [{ id }] = received.data;
    await read("GET", `/emails/receiving/${id}`);
    expect((await read("GET", `/emails/receiving/${id}/attachments`)).data).toEqual([]);
  });
});
