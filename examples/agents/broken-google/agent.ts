/**
 * A Gmail agent with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=google.redelivery` (any check id) it has exactly the bug that
 * check exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import { createVerify } from "node:crypto";

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

import { serve } from "../shared/serve.ts";

const env = process.env;
const fault = env.BROKEN ?? "";
const broken = (check: string) => fault === check;
const { GMAIL_ADDRESS = "", GOOGLE_PUSH_AUDIENCE = "", GOOGLE_CERTS_URL = "", PORT } = env;
if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REFRESH_TOKEN || !GOOGLE_PUSH_AUDIENCE || !PORT) {
  throw new Error("The agent needs its OAuth client, refresh token, push audience and PORT");
}

const auth = new OAuth2Client({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  endpoints: {
    ...(env.GOOGLE_TOKEN_URL ? { oauth2TokenUrl: env.GOOGLE_TOKEN_URL } : {}),
    ...(GOOGLE_CERTS_URL ? { oauth2FederatedSignonPemCertsUrl: GOOGLE_CERTS_URL } : {}),
  },
});
auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth, ...(env.GOOGLE_API_URL ? { rootUrl: env.GOOGLE_API_URL } : {}) });

const { data: watched } = await gmail.users.watch({
  userId: "me",
  requestBody: { topicName: env.GOOGLE_PUBSUB_TOPIC ?? "", labelIds: ["INBOX"] },
});
const start = watched.historyId ?? "";
let cursor = start;
const answered = new Set<string>();

/** The signature check without the token's lifetime: the bug `google.stale` catches. */
async function signedIgnoringTime(token: string): Promise<boolean> {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const { kid } = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { kid: string };
  const certs = (await (await fetch(GOOGLE_CERTS_URL)).json()) as Record<string, string>;
  const pem = certs[kid];
  if (!pem) return false;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { aud: string };
  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  return claims.aud === GOOGLE_PUSH_AUDIENCE && verifier.verify(pem, Buffer.from(signature, "base64url"));
}

async function verified(token: string): Promise<boolean> {
  // Bug: takes any push, signed or not.
  if (broken("google.bad-signature")) return true;
  // Bug: checks the signature and the audience, but not whether the token has expired.
  if (broken("google.stale")) return signedIgnoringTime(token);
  try {
    // Bug: checks the token, but not who it is for.
    await auth.verifyIdToken({
      idToken: token,
      ...(broken("google.wrong-audience") ? {} : { audience: GOOGLE_PUSH_AUDIENCE }),
    });
    return true;
  } catch {
    return false;
  }
}

const header = (
  message: { payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null },
  name: string,
) => message.payload?.headers?.find((each) => each.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

async function reply(id: string) {
  // Bug: answers a message every time history lists it, not once.
  if (answered.has(id) && !broken("google.redelivery")) return;
  answered.add(id);
  const { data: message } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const from = header(message, "From");
  const sender = (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase();
  if (sender === GMAIL_ADDRESS.toLowerCase() || !message.labelIds?.includes("INBOX")) return;
  // Bug: answers mail another program sent on its own, so two agents answer each other without end.
  const auto = header(message, "Auto-Submitted");
  if (auto !== "" && auto.toLowerCase() !== "no" && !broken("google.no-reply-loop")) return;
  const messageId = header(message, "Message-ID");
  const raw = [
    `From: my-agent <${GMAIL_ADDRESS}>`,
    `To: ${sender}`,
    `Subject: Re: ${header(message, "Subject")}`,
    // Bug: answers without In-Reply-To and References, so the answer starts a thread of its own.
    ...(broken("google.reply-in-thread") ? [] : [`In-Reply-To: ${messageId}`, `References: ${messageId}`]),
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Thanks, we got your email.",
  ].join("\r\n");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(raw).toString("base64url"), threadId: message.threadId ?? null },
  });
}

let queue: Promise<void> = Promise.resolve();
async function sync() {
  if (broken("google.history")) {
    // Bug: answers only the newest message in the inbox, not every one the push's history tells of.
    const { data } = await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 1 });
    for (const message of data.messages ?? []) if (message.id) await reply(message.id);
    return;
  }
  // Bug (google.redelivery): reads the history from the watch every time, instead of from where it left off.
  const from = broken("google.redelivery") ? start : cursor;
  const { data } = await gmail.users.history.list({
    userId: "me",
    startHistoryId: from,
    historyTypes: ["messageAdded"],
    labelId: "INBOX",
  });
  for (const entry of data.history ?? []) {
    for (const added of entry.messagesAdded ?? []) if (added.message?.id) await reply(added.message.id);
  }
  if (data.historyId) cursor = data.historyId;
}

serve(Number(PORT), "/webhooks/google", async (request) => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!(await verified(token))) return new Response("unauthorized", { status: 401 });
  queue = queue.then(sync, sync).catch((error: unknown) => console.error(error));
  return new Response(null, { status: 204 });
});
