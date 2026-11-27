import { createServer, type Server } from "node:http";

import twilio from "twilio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { twilioWebhookProblems } from "../schemas/twilio.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake signs like Twilio (exit check 10.3). The fake's real delivery code, in the server
 * binary, posts to a receiver that checks every request with the `twilio` SDK's `validateRequest`
 * and answers with TwiML from its `MessagingResponse`. Cases T1 to T4 of the appendix in docs/phases.md.
 */

let server: RunningBinary;
let listener: Server;
let authToken: string;
let webhookUrl: string;
let statusUrl: string;
/** What the receiver answers to a text: TwiML, or nothing but a failure. */
let answer: (params: Record<string, string>) => { status: number; twiml?: string } = () => ({ status: 200 });
/** What arrived: where, the form's parameters and the headers. */
const arrived: Array<{
  path: string;
  params: Record<string, string>;
  signature: string;
  token: string;
  valid: boolean;
}> = [];

beforeAll(async () => {
  const port = await freePort();
  webhookUrl = `http://127.0.0.1:${port}/webhooks/twilio`;
  statusUrl = `http://127.0.0.1:${port}/webhooks/twilio/status`;
  // Twilio's connection overrides ride in the fragment: two retries, for a 5xx too.
  server = await startBinary({ env: { CHANNELSTACK_TWILIO_WEBHOOK_URL: `${webhookUrl}#rc=2&rp=5xx,ct` } });
  authToken = ((await server.control("GET", "/env")).body as { TWILIO_AUTH_TOKEN: string }).TWILIO_AUTH_TOKEN;
  // The receiver as Twilio's guide has it: the URL Twilio requested and the posted parameters, then TwiML.
  listener = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const params = Object.fromEntries(new URLSearchParams(body));
    const path = incoming.url ?? "/";
    const signature = String(incoming.headers["x-twilio-signature"] ?? "");
    const valid = twilio.validateRequest(authToken, signature, `http://${incoming.headers.host}${path}`, params);
    arrived.push({
      path,
      params,
      signature,
      token: String(incoming.headers["i-twilio-idempotency-token"] ?? ""),
      valid,
    });
    if (!valid) return outgoing.writeHead(403).end();
    if (path !== "/webhooks/twilio") return outgoing.writeHead(204).end();
    const { status, twiml } = answer(params);
    outgoing
      .writeHead(status, { "content-type": "text/xml" })
      .end(twiml ?? new twilio.twiml.MessagingResponse().toString());
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana texting the agent, and the webhook it caused, settled. */
async function texted(body: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/twilio`;
  const control = (method: string, path: string, payload?: unknown) =>
    server.control(method, `${base}${path}`, payload).then((reply) => reply.body);
  const { app } = await control("GET", "");
  const ana = await control("POST", "/users", { name: "Ana" });
  const text = await control("POST", `/users/${encodeURIComponent(ana.id)}/text`, { body, to: app.id });
  const settled = (id: string) =>
    waitFor("the delivery to settle", async () => {
      const current = await control("GET", `/deliveries/${id}`);
      return current.attempts.at(-1)?.status === "pending" ? undefined : current;
    });
  const delivery = await settled(text.delivery.id);
  return { control, app, ana, text, delivery, settled };
}

describe("the fake signs like Twilio", () => {
  test("T1: a text, signed with the Auth Token over the URL and the sorted parameters, validateRequest accepts it", async () => {
    const { delivery, text } = await texted("T1");
    expect(delivery.status).toBe("acknowledged");
    const sent = arrived.find((entry) => entry.params.MessageSid === text.id);
    expect(sent?.valid).toBe(true);
    expect(sent?.signature).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(twilioWebhookProblems("message", sent?.params)).toEqual([]);
    // The URL Twilio signs is the configured one without its fragment of overrides, which never leaves Twilio.
    expect(
      twilio.validateRequest(authToken, sent?.signature ?? "", `${webhookUrl}#rc=2&rp=5xx,ct`, sent?.params ?? {}),
    ).toBe(false);
  });

  test("T2: another token, another URL or a changed parameter fails validateRequest, and a forged webhook is refused", async () => {
    const { control, delivery, text, settled } = await texted("T2");
    const sent = arrived.find((entry) => entry.params.MessageSid === text.id);
    const params = sent?.params ?? {};
    expect(twilio.validateRequest("0".repeat(32), sent?.signature ?? "", webhookUrl, params)).toBe(false);
    expect(twilio.validateRequest(authToken, sent?.signature ?? "", `${webhookUrl}/other`, params)).toBe(false);
    expect(twilio.validateRequest(authToken, sent?.signature ?? "", webhookUrl, { ...params, Body: "T2!" })).toBe(
      false,
    );
    const attempt = await control("POST", `/deliveries/${delivery.id}/resend`, { badSignature: true });
    expect(attempt).toMatchObject({ forgedSignature: true, responseStatus: 403, status: "failed" });
    expect((await settled(delivery.id)).attempts).toHaveLength(2);
  });

  test("T3: as the URL's overrides say, a 5xx is retried, with the same idempotency token and a valid signature", async () => {
    let failures = 2;
    answer = () => (failures-- > 0 ? { status: 503 } : { status: 200 });
    try {
      const { text, delivery, settled } = await texted("T3");
      const final = await waitFor(
        "the retries",
        async () => {
          const current = await settled(delivery.id);
          return current.attempts.length === 3 ? current : undefined;
        },
        { timeout: 10_000 },
      );
      expect(final.attempts.map((attempt: { responseStatus: number }) => attempt.responseStatus)).toEqual([
        503, 503, 200,
      ]);
      const attempts = arrived.filter((entry) => entry.params.MessageSid === text.id);
      expect(new Set(attempts.map((entry) => entry.token)).size).toBe(1);
      expect(attempts.every((entry) => entry.valid)).toBe(true);
    } finally {
      answer = () => ({ status: 200 });
    }
  });

  test("T4: TwiML from MessagingResponse is sent back to the sender, and its status callbacks validate", async () => {
    answer = (params) => {
      const response = new twilio.twiml.MessagingResponse();
      response.message({ statusCallback: statusUrl }, `Got "${params.Body}"`);
      return { status: 200, twiml: response.toString() };
    };
    try {
      const { control, text, ana, app } = await texted("T4");
      const [reply] = await waitFor("the TwiML's message", async () => {
        const replies = await control("GET", `/conversations/${text.conversation.id}/replies`);
        return replies.length > 0 ? replies : undefined;
      });
      expect(reply).toMatchObject({ text: 'Got "T4"', from: app.number, to: ana.number, author: { kind: "app" } });
      const callbacks = await waitFor("its status callbacks", async () => {
        const got = arrived.filter(
          (entry) => entry.path === "/webhooks/twilio/status" && entry.params.MessageSid === reply.id,
        );
        return got.length === 3 ? got : undefined;
      });
      expect(callbacks.every((entry) => entry.valid)).toBe(true);
      expect(callbacks.map((entry) => entry.params.MessageStatus).sort()).toEqual(["delivered", "queued", "sent"]);
      for (const callback of callbacks) expect(twilioWebhookProblems("status", callback.params)).toEqual([]);
    } finally {
      answer = () => ({ status: 200 });
    }
  });
});
