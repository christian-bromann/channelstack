/**
 * A Resend agent with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=resend.redelivery` (any check id) it has exactly the bug that
 * check exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { Resend } from "resend";

import { serve } from "../shared/serve.ts";

const { RESEND_API_KEY, RESEND_WEBHOOK_SECRET, PORT } = process.env;
if (!RESEND_API_KEY || !RESEND_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs RESEND_API_KEY, RESEND_WEBHOOK_SECRET and PORT");
}
const FROM = process.env.RESEND_FROM ?? "my-agent <my-agent@acme.example>";
const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;

const resend = new Resend(RESEND_API_KEY);
const answered = new Set<string>();

/** The signature check without the timestamp's: the bug `resend.stale` catches. */
function signedIgnoringTime(id: string, timestamp: string, signature: string, body: string): boolean {
  const key = Buffer.from(RESEND_WEBHOOK_SECRET!.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((entry) => {
    const given = Buffer.from(entry.replace(/^v1,/, ""), "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

async function received(id: string) {
  // Bug: answers every time Resend sends the webhook, not once per email.
  if (answered.has(id) && !broken("resend.redelivery")) return;
  answered.add(id);
  const { data: email } = await resend.emails.receiving.get(id);
  if (!email) return;
  const sender = (email.from.match(/<([^>]+)>/)?.[1] ?? email.from).toLowerCase();
  await resend.emails.send({
    from: FROM,
    to: [sender],
    subject: `Re: ${email.subject}`,
    text: "Thanks, we got your email.",
    // Bug: answers without In-Reply-To and References, so the answer starts a thread of its own.
    ...(broken("resend.reply-in-thread")
      ? {}
      : { headers: { "In-Reply-To": email.message_id, References: email.message_id } }),
  });
}

serve(Number(PORT), "/webhooks/resend", async (request, body) => {
  const headers = {
    id: request.headers.get("svix-id") ?? "",
    timestamp: request.headers.get("svix-timestamp") ?? "",
    signature: request.headers.get("svix-signature") ?? "",
  };
  // Bug: takes any webhook, signed or not. Bug: checks the signature, but not how old it is.
  const valid = broken("resend.bad-signature")
    ? true
    : broken("resend.stale")
      ? signedIgnoringTime(headers.id, headers.timestamp, headers.signature, body)
      : (() => {
          try {
            resend.webhooks.verify({ payload: body, headers, webhookSecret: RESEND_WEBHOOK_SECRET });
            return true;
          } catch {
            return false;
          }
        })();
  if (!valid) return new Response("invalid signature", { status: 400 });
  const event = JSON.parse(body) as { type: string; data: { email_id: string } };
  if (event.type === "email.received") received(event.data.email_id).catch((error: unknown) => console.error(error));
  return new Response(null, { status: 200 });
});
