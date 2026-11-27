/**
 * A Twilio agent with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=twilio.redelivery` (any check id) it has exactly the bug that
 * check exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import twilio from "twilio";

import { formParams, listen, twilioClient } from "../shared/twilio.ts";

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, PORT } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PORT) {
  throw new Error("The agent needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER and PORT");
}
const AUTH_TOKEN: string = TWILIO_AUTH_TOKEN;
const NUMBER: string = TWILIO_PHONE_NUMBER;
const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;

const client = twilioClient(TWILIO_ACCOUNT_SID, AUTH_TOKEN);
const answered = new Set<string>();

async function reply(params: Record<string, string>) {
  const sid = params.MessageSid ?? "";
  // Bug: answers every time Twilio sends the webhook, not once per text.
  if (answered.has(sid) && !broken("twilio.redelivery")) return;
  answered.add(sid);
  if (params.OptOutType !== undefined) return;
  await client.messages.create({
    // Bug: answers the webhook's `To`, the agent's own number, instead of `From`, who texted.
    to: (broken("twilio.reply-to-sender") ? params.To : params.From) ?? "",
    from: NUMBER,
    body: "Thanks, we got your text.",
  });
}

listen(Number(PORT), {
  "/webhooks/twilio": (url, request, body) => {
    const params = formParams(body);
    // Bug: takes any webhook, signed or not.
    const valid =
      broken("twilio.bad-signature") ||
      twilio.validateRequest(AUTH_TOKEN, String(request.headers["x-twilio-signature"] ?? ""), url, params);
    if (!valid) return { status: 403, body: "invalid signature" };
    reply(params).catch((error: unknown) => console.error(error));
    return { status: 200, type: "text/xml", body: "<Response/>" };
  },
});
