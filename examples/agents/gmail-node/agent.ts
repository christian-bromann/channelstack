/**
 * A Gmail agent on Google's own libraries, written the way Google's guides show: the mailbox
 * watched with `users.watch`, every Pub/Sub push checked with `OAuth2Client.verifyIdToken` (its
 * audience, and the push service account), history read with `users.history.list`, and the
 * answer sent with `users.messages.send` on the message's thread. It is configured from the
 * environment `channelstack env` prints and talks to whatever `GOOGLE_API_URL` points at: the fake
 * in tests, Gmail itself when the variable is unset. It has no channelstack code in it.
 */
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

import { gmailAgent } from "../shared/gmail.ts";
import { serve } from "../shared/serve.ts";

const {
  GOOGLE_API_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_CERTS_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GMAIL_ADDRESS,
  GOOGLE_PUBSUB_TOPIC,
  GOOGLE_PUSH_AUDIENCE,
  GOOGLE_PUSH_SERVICE_ACCOUNT,
  PORT,
} = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !GMAIL_ADDRESS || !GOOGLE_PUBSUB_TOPIC) {
  throw new Error("The agent needs its OAuth client, refresh token, address and Pub/Sub topic");
}
if (!GOOGLE_PUSH_AUDIENCE || !GOOGLE_PUSH_SERVICE_ACCOUNT || !PORT) {
  throw new Error("The agent needs GOOGLE_PUSH_AUDIENCE, GOOGLE_PUSH_SERVICE_ACCOUNT and PORT");
}

// Google's endpoints, unless the environment points them elsewhere.
const auth = new OAuth2Client({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  endpoints: {
    ...(GOOGLE_TOKEN_URL ? { oauth2TokenUrl: GOOGLE_TOKEN_URL } : {}),
    ...(GOOGLE_CERTS_URL ? { oauth2FederatedSignonPemCertsUrl: GOOGLE_CERTS_URL } : {}),
  },
});
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
// `rootUrl` per API: googleapis ignores it in `google.options`.
const gmail = google.gmail({ version: "v1", auth, ...(GOOGLE_API_URL ? { rootUrl: GOOGLE_API_URL } : {}) });
// The app it runs as: the stack names another one in AGENT_NAME (decision 0027).
const agent = gmailAgent(gmail, {
  address: GMAIL_ADDRESS,
  name: process.env.AGENT_NAME ?? "my-agent",
  topic: GOOGLE_PUBSUB_TOPIC,
});
await agent.start();

serve(Number(PORT), "/webhooks/google", async (request) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  try {
    const ticket = await auth.verifyIdToken({ idToken: token, audience: GOOGLE_PUSH_AUDIENCE });
    const claims = ticket.getPayload();
    if (claims?.email !== GOOGLE_PUSH_SERVICE_ACCOUNT || !claims.email_verified) throw new Error("not Gmail's push");
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  // Pub/Sub wants an answer within its ack deadline; the work happens after it.
  agent.notified().catch((error: unknown) => console.error("The agent failed:", error));
  return new Response(null, { status: 204 });
});
