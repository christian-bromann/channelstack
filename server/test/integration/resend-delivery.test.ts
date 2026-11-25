import { createServer, type Server } from "node:http";

import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { resendResponseProblems, resendWebhookProblems } from "../schemas/resend.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake signs like Resend (exit check 8.4). The fake's real delivery code, in the compiled
 * binary, sends to a receiver that checks every webhook with the `resend` SDK's `webhooks.verify`
 * (Standard Webhooks, as Svix signs). Cases R1 to R3 of the appendix in docs/phases.md.
 */

let server: RunningBinary;
let listener: Server;
let secret: string;
const resend = new Resend("re_unused_by_verify");
/** What arrived: the exact bytes and the Svix headers. */
const arrived: Array<{ raw: string; id: string; timestamp: string; signature: string }> = [];

const verifies = (
  raw: string,
  headers: { id: string; timestamp: string; signature: string },
  webhookSecret = secret,
) => {
  try {
    resend.webhooks.verify({ payload: raw, headers, webhookSecret });
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({ env: { CHANNELSTACK_RESEND_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/resend` } });
  secret = ((await server.control("GET", "/env")).body as { RESEND_WEBHOOK_SECRET: string }).RESEND_WEBHOOK_SECRET;
  // The receiver as Resend's guide has it: verify the bytes as they came, then parse.
  listener = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const headers = {
      id: String(incoming.headers["svix-id"] ?? ""),
      timestamp: String(incoming.headers["svix-timestamp"] ?? ""),
      signature: String(incoming.headers["svix-signature"] ?? ""),
    };
    arrived.push({ raw, ...headers });
    outgoing.writeHead(verifies(raw, headers) ? 200 : 400).end();
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana emailing the agent, and the `email.received` delivery it caused. */
async function emailed(subject: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/resend`;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((reply) => reply.body);
  const { app } = (await server.control("GET", base)).body;
  const ana = await act("/users", { name: "Ana" });
  const email = await act(`/users/${encodeURIComponent(ana.id)}/send`, { to: [app.id], subject, text: "Hello" });
  const settled = (id: string) =>
    waitFor("the delivery to settle", async () => {
      const current = (await server.control("GET", `${base}/deliveries/${id}`)).body;
      return current.attempts.at(-1)?.status === "pending" ? undefined : current;
    });
  const delivery = await settled(email.delivery.id);
  const sent = arrived.find((entry) => entry.id === email.delivery.id);
  if (!sent) throw new Error("The delivery never arrived");
  return { base, email, delivery, sent, settled, act };
}

describe("the fake signs like Resend", () => {
  test("R1: email.received signed with the webhook secret over the sent bytes, webhooks.verify accepts it", async () => {
    const { delivery, sent } = await emailed("R1");
    expect(delivery.status).toBe("acknowledged");
    expect(sent.id).toMatch(/^msg_[0-9A-Za-z]{27}$/);
    expect(sent.signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(verifies(sent.raw, sent)).toBe(true);
    // And it is what Resend's description says an `email.received` is.
    expect(resendWebhookProblems("email.received", JSON.parse(sent.raw))).toEqual([]);
  });

  test("R2: the same event serialized again, or signed with another secret, is rejected", async () => {
    const { delivery, sent, settled, act } = await emailed("R2");
    const again = JSON.stringify(JSON.parse(sent.raw), null, 2);
    expect(verifies(again, sent)).toBe(false);
    // The fake's forged copy: a secret that isn't the webhook's.
    await act(`/deliveries/${delivery.id}/resend`, { badSignature: true });
    const forged = await settled(delivery.id);
    expect(forged.attempts.at(-1)).toMatchObject({ forgedSignature: true, responseStatus: 400 });
  });

  test("R3: signed more than five minutes ago it is rejected; Resend's retry signs again, and is accepted", async () => {
    const { delivery, act, settled } = await emailed("R3");
    await act(`/deliveries/${delivery.id}/resend`, { stale: true });
    expect((await settled(delivery.id)).attempts.at(-1)).toMatchObject({ forgedSignature: true, responseStatus: 400 });
    await act(`/deliveries/${delivery.id}/redeliver`);
    const retried = (await settled(delivery.id)).attempts.at(-1);
    expect(retried).toMatchObject({ forgedSignature: false, responseStatus: 200 });
    // Every attempt (the first, the stale copy, the retry) carries the same message id, what a
    // receiver deduplicates by; the retry is signed again, at its own time.
    const attempts = arrived.filter((entry) => entry.id === delivery.id);
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    const [stale, again] = attempts.slice(-2) as [(typeof attempts)[0], (typeof attempts)[0]];
    expect(Number(again.timestamp)).toBeGreaterThan(Number(stale.timestamp));
    expect(again.signature).not.toBe(stale.signature);
  });

  test("the receiving API answers what Resend's description says", async () => {
    const { email } = await emailed("Read back");
    const env = (await server.control("GET", "/env")).body as { RESEND_API_KEY: string; RESEND_BASE_URL: string };
    const response = await fetch(`${env.RESEND_BASE_URL}/emails/receiving/${email.id}`, {
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "user-agent": "resend-delivery-test" },
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(resendResponseProblems("GET", `/emails/receiving/${email.id}`, 200, body)).toEqual([]);
  });
});
