import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { twilioResponseProblems, twilioWebhookProblems } from "../../../test/schemas/twilio.ts";
import { twilioSignature } from "./signing.ts";
import { segmentsOf } from "./sms.ts";

/**
 * The Twilio fake's API as an agent meets it: what it refuses as Twilio does, what the test
 * credentials' magic numbers do, its webhooks and status callbacks, and that every answer and
 * webhook is what Twilio's description says (exit check 10.2).
 */
let agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents) agent.close();
  agents = [];
});

const form = (fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) for (const each of [value].flat()) params.append(name, each);
  return params.toString();
};

async function account(options: { webhook?: string } = {}) {
  const agent = await recordingAgent();
  agents.push(agent);
  const h = harness({ twilio: options.webhook ?? agent.url });
  const { sessionId } = (await h.call("POST", `/sessions`)).body;
  const control = (method: string, path: string, body?: unknown) =>
    h.call(method, `/sessions/${sessionId}/twilio${path}`, body);
  const fixture = (await control("GET", "")).body as { app: { number: string; id: string } };
  const env = (await h.call("GET", `/env`)).body as Record<string, string>;
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
  const auth = basic(sid, env.TWILIO_AUTH_TOKEN as string);
  const api = (method: string, path: string, body?: Record<string, string | string[]>, authorization = auth) =>
    h.provider(method, `twilio/2010-04-01/Accounts/${sid}${path}`, body === undefined ? undefined : form(body), null, {
      authorization,
      ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    });
  /** Call, and hold the answer to Twilio's description. */
  const call = async (method: string, path: string, body?: Record<string, string | string[]>, authorization = auth) => {
    const reply = await api(method, path, body, authorization);
    const template = `/2010-04-01/Accounts/${sid}${path.split("?")[0]}`;
    expect(twilioResponseProblems(method, template, reply.status, reply.body)).toEqual([]);
    return reply;
  };
  /** The webhooks delivered so far, as their parameters, each held to Twilio's description. */
  const webhooks = async () => {
    await h.app.settled();
    return agent.received.map((delivery) => {
      const params = Object.fromEntries(new URLSearchParams(delivery.body));
      const type = "MessageStatus" in params ? "status" : "message";
      expect(twilioWebhookProblems(type, params)).toEqual([]);
      return { type, params, headers: delivery.headers };
    });
  };
  const ana = (await control("POST", "/users", { name: "Ana" })).body as { id: string; number: string };
  return { h, agent, env, sid, auth, basic, api, call, control, webhooks, fixture, ana, app: fixture.app };
}

/** Twilio's refusal: `{ code, message, more_info, status }`. */
function expectRefusal(reply: { status: number; body: Record<string, unknown> }, status: number, code: number) {
  expect(reply.status).toBe(status);
  expect(reply.body).toMatchObject({
    code,
    status,
    message: expect.any(String),
    more_info: `https://www.twilio.com/docs/errors/${code}`,
  });
}

describe("what the Twilio fake refuses, as Twilio does", () => {
  test("no credentials, wrong ones, another account's", async () => {
    const { api, basic, sid, app, ana } = await account();
    const message = { To: ana.number, From: app.number, Body: "hi" };
    const none = await api("POST", "/Messages.json", message, "");
    expectRefusal(none, 401, 20003);
    expectRefusal(await api("POST", "/Messages.json", message, basic(sid, "0".repeat(32))), 401, 20003);
    const other = `AC${"0".repeat(32)}`;
    expectRefusal(await api("GET", `/Messages/${other}.json`, undefined, basic(other, "0".repeat(32))), 401, 20003);
  });

  test("an API key works as the account's credentials", async () => {
    const { call, basic, env, app, ana } = await account();
    const reply = await call(
      "POST",
      "/Messages.json",
      { To: ana.number, From: app.number, Body: "hi" },
      basic(env.TWILIO_API_KEY as string, env.TWILIO_API_SECRET as string),
    );
    expect(reply.status).toBe(201);
  });

  test.each([
    [{ From: "+15005550006", Body: "hi" }, 21604],
    [{ To: "+14155550100", Body: "hi" }, 21603],
    [{ To: "+14155550100", From: "app" }, 21602],
    [{ To: "415-555-0100", From: "app", Body: "hi" }, 21211],
    [{ To: "+14155550100", From: "+19995550100", Body: "hi" }, 21606],
    [{ To: "+14155550100", From: "not-a-number", Body: "hi" }, 21212],
    [{ To: "app", From: "app", Body: "hi" }, 21266],
    [{ To: "+14155550100", From: "app", Body: "x".repeat(1601) }, 21617],
    [{ To: "+14155550100", MessagingServiceSid: `MG${"0".repeat(32)}`, Body: "hi" }, 21701],
  ])("%j is refused with %i", async (fields, code) => {
    const { api, app } = await account();
    const body = Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, value === "app" ? app.number : value]),
    );
    expectRefusal(await api("POST", "/Messages.json", body), 400, code);
  });

  test("a path Twilio doesn't have, a message that isn't there", async () => {
    const { api } = await account();
    expectRefusal(await api("GET", "/Nothing.json"), 404, 20404);
    expectRefusal(await api("GET", `/Messages/SM${"0".repeat(32)}.json`), 404, 20404);
  });
});

describe("the test credentials", () => {
  test("sending works with the magic From, and nothing is sent", async () => {
    const { h, env, basic } = await account();
    const test = basic(env.TWILIO_TEST_ACCOUNT_SID as string, env.TWILIO_TEST_AUTH_TOKEN as string);
    const reply = await h.provider(
      "POST",
      `twilio/2010-04-01/Accounts/${env.TWILIO_TEST_ACCOUNT_SID}/Messages.json`,
      form({ To: "+14155550100", From: "+15005550006", Body: "hi" }),
      null,
      { authorization: test, "content-type": "application/x-www-form-urlencoded" },
    );
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      status: "queued",
      account_sid: env.TWILIO_TEST_ACCOUNT_SID,
      to: "+14155550100",
    });
    expect(
      twilioResponseProblems(
        "POST",
        `/2010-04-01/Accounts/${env.TWILIO_TEST_ACCOUNT_SID}/Messages.json`,
        201,
        reply.body,
      ),
    ).toEqual([]);
  });

  test.each([
    [{ From: "+15005550001", To: "+14155550100" }, 21212],
    [{ From: "+15005550007", To: "+14155550100" }, 21606],
    [{ From: "+15005550008", To: "+14155550100" }, 21611],
    [{ From: "+14155550100", To: "+14155550101" }, 21606],
    [{ From: "+15005550006", To: "+15005550001" }, 21211],
    [{ From: "+15005550006", To: "+15005550002" }, 21612],
    [{ From: "+15005550006", To: "+15005550003" }, 21408],
    [{ From: "+15005550006", To: "+15005550004" }, 21610],
    [{ From: "+15005550006", To: "+15005550009" }, 21614],
  ])("%j is refused with %i", async (fields, code) => {
    const { h, env, basic } = await account();
    const test = basic(env.TWILIO_TEST_ACCOUNT_SID as string, env.TWILIO_TEST_AUTH_TOKEN as string);
    const reply = await h.provider(
      "POST",
      `twilio/2010-04-01/Accounts/${env.TWILIO_TEST_ACCOUNT_SID}/Messages.json`,
      form({ Body: "hi", ...fields }),
      null,
      { authorization: test, "content-type": "application/x-www-form-urlencoded" },
    );
    expectRefusal(reply, 400, code);
  });

  test("they read nothing", async () => {
    const { h, env, basic } = await account();
    const test = basic(env.TWILIO_TEST_ACCOUNT_SID as string, env.TWILIO_TEST_AUTH_TOKEN as string);
    const reply = await h.provider(
      "GET",
      `twilio/2010-04-01/Accounts/${env.TWILIO_TEST_ACCOUNT_SID}/Messages.json`,
      undefined,
      null,
      { authorization: test },
    );
    expectRefusal(reply, 403, 20008);
  });
});

describe("a person texts the agent", () => {
  test("the webhook is form-encoded and signed over the URL and the sorted parameters", async () => {
    const { control, webhooks, agent, env, ana, app } = await account();
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "Where is my order?", to: app.id })).body;
    const [webhook] = await webhooks();
    expect(webhook?.params).toMatchObject({
      MessageSid: sent.id,
      From: ana.number,
      To: app.number,
      Body: "Where is my order?",
      SmsStatus: "received",
      NumSegments: "1",
      AccountSid: env.TWILIO_ACCOUNT_SID,
    });
    const body = agent.received[0]?.body as string;
    expect(webhook?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(webhook?.headers["x-twilio-signature"]).toBe(
      twilioSignature(env.TWILIO_AUTH_TOKEN as string, agent.url, body),
    );
    expect(webhook?.headers["i-twilio-idempotency-token"]).toBe(sent.delivery.id);
    expect(webhook?.headers["user-agent"]).toBe("TwilioProxy/1.1");
  });

  test("the agent's TwiML answer is sent back to the sender", async () => {
    const { h, control, agent, ana, app } = await account();
    agent.respond = () => ({
      status: 200,
      headers: { "content-type": "text/xml" },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>On its way &amp; soon</Message></Response>',
    });
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "Where is my order?", to: app.id })).body;
    await h.app.settled();
    const replies = (await control("GET", `/conversations/${sent.conversation.id}/replies`)).body;
    expect(replies).toMatchObject([
      { body: "On its way & soon", from: app.number, to: ana.number, author: { kind: "app" } },
    ]);
  });

  test("a retry's TwiML is sent too: the agent must answer once", async () => {
    const { h, control, agent, ana, app } = await account();
    agent.respond = () => ({
      status: 200,
      headers: { "content-type": "text/xml" },
      body: "<Response><Message>Hi</Message></Response>",
    });
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "hello", to: app.id })).body;
    await h.app.settled();
    await control("POST", `/deliveries/${sent.delivery.id}/redeliver`);
    await h.app.settled();
    expect(agent.received[1]?.headers["i-twilio-idempotency-token"]).toBe(sent.delivery.id);
    expect((await control("GET", `/conversations/${sent.conversation.id}/replies`)).body).toHaveLength(2);
  });

  test("a forged webhook is signed with another token", async () => {
    const { h, control, agent, env, ana, app } = await account();
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "hello", to: app.id })).body;
    await control("POST", `/deliveries/${sent.delivery.id}/resend`, { badSignature: true });
    await h.app.settled();
    const forged = agent.received[1];
    expect(forged?.headers["x-twilio-signature"]).not.toBe(
      twilioSignature(env.TWILIO_AUTH_TOKEN as string, agent.url, forged?.body ?? ""),
    );
  });

  test("by default Twilio retries once, only when it couldn't connect", async () => {
    const { h, control, agent, ana, app } = await account();
    agent.respond = () => ({ status: 500 });
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "hello", to: app.id })).body;
    await h.app.settled();
    h.timers.advance(10_000);
    await h.app.settled();
    expect((await control("GET", `/deliveries/${sent.delivery.id}`)).body.attempts).toHaveLength(1);
  });

  test("the URL's connection overrides say how Twilio retries, and the signature leaves them out", async () => {
    const first = await recordingAgent();
    agents.push(first);
    const url = `${first.url}#rc=2&rp=5xx`;
    const { h, control, env, ana, app } = await account({ webhook: url });
    first.respond = () => ({ status: 503 });
    const sent = (await control("POST", `/users/${ana.id}/text`, { body: "hello", to: app.id })).body;
    for (let n = 0; n < 3; n++) {
      await h.app.settled();
      h.timers.advance(1_000);
    }
    await h.app.settled();
    expect(first.received).toHaveLength(3);
    expect(first.received[0]?.headers["x-twilio-signature"]).toBe(
      twilioSignature(env.TWILIO_AUTH_TOKEN as string, first.url, first.received[0]?.body ?? ""),
    );
    expect((await control("GET", `/deliveries/${sent.delivery.id}`)).body.attempts).toHaveLength(3);
  });

  test("STOP: Twilio answers, tells the agent, and refuses the agent's next text until START", async () => {
    const { h, control, call, api, webhooks, ana, app } = await account();
    const stop = (await control("POST", `/users/${ana.id}/text`, { body: " stop ", to: app.id })).body;
    expect((await webhooks())[0]?.params.OptOutType).toBe("STOP");
    const transcript = (await control("GET", `/conversations/${stop.conversation.id}/transcript`)).body;
    expect(transcript.text).toMatch(/my-agent: You have successfully been unsubscribed.*\(sent by Twilio\)/);
    expectRefusal(await api("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "hi" }), 400, 21610);
    await control("POST", `/users/${ana.id}/text`, { body: "START", to: app.id });
    await h.app.settled();
    expect((await call("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "hi" })).status).toBe(201);
  });
});

describe("the agent texts a person", () => {
  test("it is queued, then sent and delivered, as a fetch reads it back", async () => {
    const { call, control, ana, app } = await account();
    const created = (
      await call("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "Your order shipped" })
    ).body;
    expect(created).toMatchObject({ status: "queued", direction: "outbound-api", num_segments: "1", date_sent: null });
    expect(created.sid).toMatch(/^SM[0-9a-f]{32}$/);
    const fetched = (await call("GET", `/Messages/${created.sid}.json`)).body;
    expect(fetched).toMatchObject({ status: "delivered", price_unit: "USD" });
    expect(fetched.date_sent).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    const inbox = (await control("GET", `/users/${ana.id}/messages`)).body;
    expect(inbox).toMatchObject([{ body: "Your order shipped", author: { kind: "app", name: "my-agent" } }]);
  });

  test("through the Messaging Service, from its number", async () => {
    const { call, env, ana } = await account();
    const created = (
      await call("POST", "/Messages.json", {
        To: ana.number,
        MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID as string,
        Body: "hi",
      })
    ).body;
    expect(created).toMatchObject({
      from: env.TWILIO_PHONE_NUMBER,
      messaging_service_sid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
  });

  test("its status callbacks: queued, sent, delivered", async () => {
    const { call, webhooks, agent, env, ana, app } = await account();
    const created = (
      await call("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "hi", StatusCallback: agent.url })
    ).body;
    const callbacks = await webhooks();
    expect(callbacks.map(({ params }) => params.MessageStatus).sort()).toEqual(["delivered", "queued", "sent"]);
    for (const { params, headers, type } of callbacks) {
      expect(type).toBe("status");
      expect(params.MessageSid).toBe(created.sid);
      expect(headers["x-twilio-signature"]).toBe(
        twilioSignature(env.TWILIO_AUTH_TOKEN as string, agent.url, new URLSearchParams(params).toString()),
      );
    }
  });

  test("to a phone that's off: undelivered, with 30003", async () => {
    const { call, control, webhooks, agent, app } = await account();
    const ben = (await control("POST", "/users", { name: "Ben", reachable: false })).body;
    const created = (
      await call("POST", "/Messages.json", { To: ben.number, From: app.number, Body: "hi", StatusCallback: agent.url })
    ).body;
    const last = (await webhooks()).find(({ params }) => params.MessageStatus === "undelivered");
    expect(last?.params.ErrorCode).toBe("30003");
    expect((await call("GET", `/Messages/${created.sid}.json`)).body).toMatchObject({
      status: "undelivered",
      error_code: 30003,
      error_message: "Unreachable destination handset",
    });
  });

  test("list, redact and delete", async () => {
    const { call, ana, app } = await account();
    const one = (await call("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "one" })).body;
    await call("POST", "/Messages.json", { To: ana.number, From: app.number, Body: "two" });
    const listed = (await call("GET", `/Messages.json?To=${encodeURIComponent(ana.number)}&PageSize=1`)).body;
    expect(listed.messages.map((message: { body: string }) => message.body)).toEqual(["two"]);
    expect(listed.next_page_uri).toContain("Page=1");
    expect((await call("POST", `/Messages/${one.sid}.json`, { Body: "" })).body.body).toBe("");
    expect((await call("DELETE", `/Messages/${one.sid}.json`)).status).toBe(204);
  });

  test("the account and its number", async () => {
    const { call, sid, app } = await account();
    expect((await call("GET", ".json")).body).toMatchObject({ sid, status: "active" });
    const numbers = (await call("GET", "/IncomingPhoneNumbers.json")).body;
    expect(numbers.incoming_phone_numbers).toMatchObject([
      { phone_number: app.number, sid: app.id, capabilities: { sms: true } },
    ]);
  });
});

describe("segments, as Twilio counts them", () => {
  test.each([
    ["", 1],
    ["a".repeat(160), 1],
    ["a".repeat(161), 2],
    ["a".repeat(306), 2],
    ["a".repeat(307), 3],
    ["€".repeat(80), 1],
    ["€".repeat(81), 2],
    ["é".repeat(160), 1],
    ["ç".repeat(70), 1],
    ["ç".repeat(71), 2],
    ["😀".repeat(35), 1],
    ["😀".repeat(36), 2],
  ])("%j is %i", (body, segments) => {
    expect(segmentsOf(body)).toBe(segments);
  });
});
