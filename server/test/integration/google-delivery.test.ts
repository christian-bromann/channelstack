import { createServer, type Server } from "node:http";

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { googlePushProblems } from "../schemas/google.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake's pushes carry tokens like Pub/Sub's (exit check 9.3). The fake's real delivery code,
 * in the compiled binary, pushes to a receiver that checks every token the way Google's guide
 * says: `OAuth2Client.verifyIdToken` against the fake's certificates, with the push endpoint as
 * the audience, then the push service account. Cases M1 to M3 of the appendix in docs/phases.md.
 */

interface GoogleEnv {
  GOOGLE_API_URL: string;
  GOOGLE_TOKEN_URL: string;
  GOOGLE_CERTS_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GOOGLE_PUBSUB_TOPIC: string;
  GOOGLE_PUSH_AUDIENCE: string;
  GOOGLE_PUSH_SERVICE_ACCOUNT: string;
}

let server: RunningBinary;
let listener: Server;
let env: GoogleEnv;
let auth: OAuth2Client;
/** What arrived: the body, and how the token check went. */
const arrived: Array<{ body: Record<string, any>; claims?: Record<string, unknown>; refused?: string }> = [];

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({ env: { CHANNELSTACK_GOOGLE_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/google` } });
  env = (await server.control("GET", "/env")).body as GoogleEnv;
  auth = new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    endpoints: { oauth2TokenUrl: env.GOOGLE_TOKEN_URL, oauth2FederatedSignonPemCertsUrl: env.GOOGLE_CERTS_URL },
  });
  auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  // The receiver as Google's guide has it: the token's audience is the endpoint, its email the push account.
  listener = createServer(async (incoming, outgoing) => {
    let text = "";
    for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text);
    const idToken = String(incoming.headers.authorization ?? "").replace(/^Bearer /, "");
    try {
      const ticket = await auth.verifyIdToken({ idToken, audience: env.GOOGLE_PUSH_AUDIENCE });
      const claims = ticket.getPayload() as unknown as Record<string, unknown>;
      if (claims.email !== env.GOOGLE_PUSH_SERVICE_ACCOUNT || claims.email_verified !== true) {
        throw new Error("not the push service account");
      }
      arrived.push({ body, claims });
      outgoing.writeHead(204).end();
    } catch (error) {
      arrived.push({ body, refused: (error as Error).message });
      outgoing.writeHead(401).end();
    }
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
  // The agent watches its inbox, through `googleapis` with the fake as its root.
  const gmail = google.gmail({ version: "v1", auth, rootUrl: env.GOOGLE_API_URL });
  await gmail.users.watch({ userId: "me", requestBody: { topicName: env.GOOGLE_PUBSUB_TOPIC, labelIds: ["INBOX"] } });
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana emailing the agent, and the push it caused. */
async function emailed(subject: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/google`;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((reply) => reply.body);
  const { app } = (await server.control("GET", base)).body;
  const ana = await act("/users", { name: "Ana" });
  const email = await act(`/users/${encodeURIComponent(ana.id)}/send`, { to: [app.id], subject, text: "Hello" });
  const settled = (id: string, attempts: number) =>
    waitFor("the push to settle", async () => {
      const current = (await server.control("GET", `${base}/deliveries/${id}`)).body;
      return current.attempts.length >= attempts && current.attempts.at(-1)?.status !== "pending" ? current : undefined;
    });
  const delivery = await settled(email.delivery.id, 1);
  /** The latest arrival of this push. */
  const latest = () => arrived.filter((entry) => entry.body.message?.messageId === email.delivery.id).at(-1);
  return { email, delivery, settled, act, latest };
}

describe("the fake's pushes carry Pub/Sub's tokens", () => {
  test("M1: verifyIdToken accepts a push's token against the fake's certificates, with the push endpoint as audience", async () => {
    const { delivery, latest } = await emailed("M1");
    expect(delivery.status).toBe("acknowledged");
    const push = latest();
    expect(push?.refused).toBeUndefined();
    expect(push?.claims).toMatchObject({
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_PUSH_AUDIENCE,
      email: env.GOOGLE_PUSH_SERVICE_ACCOUNT,
      email_verified: true,
    });
    const claims = push?.claims as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(3600);
    // The body is Pub/Sub's push, and its data Gmail's notification.
    expect(googlePushProblems(push?.body)).toEqual([]);
    const notification = JSON.parse(Buffer.from(push?.body.message.data, "base64").toString("utf8"));
    expect(notification).toEqual({ emailAddress: "my-agent@acme.example", historyId: delivery.historyId });
  });

  test("M2: a token for another audience, or signed by another key, is rejected", async () => {
    const { email, act, settled, latest } = await emailed("M2");
    await act(`/deliveries/${email.delivery.id}/resend`, { wrongAudience: true });
    const forAnother = await settled(email.delivery.id, 2);
    expect(forAnother.attempts.at(-1)).toMatchObject({ forgedSignature: true, responseStatus: 401 });
    expect(latest()?.refused).toMatch(/^Wrong recipient, payload audience != requiredAudience/);

    await act(`/deliveries/${email.delivery.id}/resend`, { badSignature: true });
    const otherKey = await settled(email.delivery.id, 3);
    expect(otherKey.attempts.at(-1)).toMatchObject({ forgedSignature: true, responseStatus: 401 });
    expect(latest()?.refused).toMatch(/^Invalid token signature/);
  });

  test("M3: an expired token is rejected", async () => {
    const { email, act, settled, latest } = await emailed("M3");
    await act(`/deliveries/${email.delivery.id}/resend`, { stale: true });
    const expired = await settled(email.delivery.id, 2);
    expect(expired.attempts.at(-1)).toMatchObject({ forgedSignature: true, responseStatus: 401 });
    expect(latest()?.refused).toMatch(/^Token used too late/);
  });
});
