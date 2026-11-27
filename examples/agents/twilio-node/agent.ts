/**
 * A Twilio SMS agent on Twilio's own SDK, written the way Twilio's guides show: every webhook
 * checked with `twilio.validateRequest`, answered at once with empty TwiML, and the reply sent with
 * `client.messages.create` to the number that texted, with a status callback. It is configured from
 * the environment `channelstack env` prints and talks to whatever `TWILIO_API_URL` points at: the
 * fake in tests, Twilio itself when the variable is unset. It has no channelstack code in it.
 */
import twilio from "twilio";

import { formParams, listen, scriptedText, twilioClient } from "../shared/twilio.ts";

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, PORT } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PORT) {
  throw new Error("The agent needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER and PORT");
}
const AUTH_TOKEN: string = TWILIO_AUTH_TOKEN;
const NUMBER: string = TWILIO_PHONE_NUMBER;
/**
 * The URL Twilio signs: the one the number's webhook is set to. Behind a relay that isn't the URL
 * the request arrives at, so it is configured; otherwise it is the request's own.
 */
const WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL;
/** Where Twilio tells the agent what became of its texts. Empty for none. */
const STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL ?? `http://127.0.0.1:${PORT}/webhooks/twilio/status`;

const client = twilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
/** The texts answered so far: Twilio retries a webhook with the same `MessageSid`. */
const answered = new Set<string>();
/** What became of each text the agent sent, as its status callbacks said. */
const statuses = new Map<string, string>();

const signed = (url: string, signature: string | string[] | undefined, params: Record<string, string>) =>
  twilio.validateRequest(AUTH_TOKEN, String(signature ?? ""), url, params);

async function reply(params: Record<string, string>) {
  const { MessageSid: sid = "", From: from = "", Body: body = "", OptOutType: optOut } = params;
  if (answered.has(sid)) return;
  answered.add(sid);
  // Twilio answers STOP, START and HELP itself, and a person who opted out can't be texted.
  if (optOut !== undefined) return;
  await client.messages.create({
    to: from,
    from: NUMBER,
    body: scriptedText(body),
    ...(STATUS_CALLBACK_URL ? { statusCallback: STATUS_CALLBACK_URL } : {}),
  });
}

listen(Number(PORT), {
  "/webhooks/twilio": (url, request, body) => {
    const params = formParams(body);
    if (!signed(WEBHOOK_URL ?? url, request.headers["x-twilio-signature"], params)) {
      return { status: 403, body: "invalid signature" };
    }
    // Twilio waits for TwiML; the answer is sent through the API once the webhook is answered.
    reply(params).catch((error: unknown) => console.error("The agent failed:", error));
    return { status: 200, type: "text/xml", body: new twilio.twiml.MessagingResponse().toString() };
  },
  "/webhooks/twilio/status": (url, request, body) => {
    const params = formParams(body);
    if (!signed(STATUS_CALLBACK_URL || url, request.headers["x-twilio-signature"], params)) {
      return { status: 403, body: "invalid signature" };
    }
    statuses.set(params.MessageSid ?? "", params.MessageStatus ?? "");
    return { status: 204 };
  },
});
