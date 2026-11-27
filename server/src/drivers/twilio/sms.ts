/**
 * What SMS is, as Twilio counts it: E.164 numbers, segments in GSM-7 or UCS-2, the 1600-character
 * limit, and the keywords Twilio answers itself.
 */

/** An E.164 number: `+`, a country code that doesn't start with 0, at most 15 digits. */
export const isE164 = (number: string): boolean => /^\+[1-9]\d{6,14}$/.test(number);

/** The most a message's body may be: 1600 characters (error 21617). */
export const BODY_LIMIT = 1600;

/** GSM 03.38's basic characters: one septet each. */
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** Its extension table: an escape and the character, two septets each. */
const GSM_EXTENDED = new Set("\f^{}\\[~]|€");

/**
 * How many segments a body is sent in, as Twilio counts them: in GSM-7, 160 septets fit in one,
 * and 153 in each of several; anything outside GSM-7 sends the whole body in UCS-2, 70 UTF-16 units
 * in one and 67 in each of several.
 */
export function segmentsOf(body: string): number {
  if (body.length === 0) return 1;
  let septets = 0;
  for (const char of body) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else return body.length <= 70 ? 1 : Math.ceil(body.length / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

/** What a person's text does to their subscription with Twilio's default opt-out handling, if anything. */
export type OptOutType = "STOP" | "START" | "HELP";

/** The keywords Twilio acts on by default: the whole text, any case, without the spaces around it. */
export function optOutTypeOf(body: string): OptOutType | undefined {
  const word = body.trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE", "STOP ALL"].includes(word)) {
    return "STOP";
  }
  if (["START", "YES", "UNSTOP"].includes(word)) return "START";
  if (["HELP", "INFO"].includes(word)) return "HELP";
  return undefined;
}

/** Twilio's own answers to those keywords, from the number they were sent to. */
export const OPT_OUT_REPLIES: Readonly<Record<OptOutType, string>> = {
  STOP: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.",
  START:
    "You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
  HELP: "Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
};

/** Whether a text from the agent's number is one of Twilio's own answers, as a live world reads it back. */
export const isTwilioAnswer = (body: string): boolean => Object.values(OPT_OUT_REPLIES).includes(body);
