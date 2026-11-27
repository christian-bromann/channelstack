import { DIGITS, HEX, idFormats, type IdShape } from "../../core/ids/index.ts";

/** A Twilio SID: two letters that say what it is, and 32 hex characters. */
const sid = (prefix: string): IdShape => ({
  pattern: new RegExp(`^${prefix}[0-9a-f]{32}$`),
  generate: (draw) => `${prefix}${draw.chars(32, HEX)}`,
});

/**
 * Every id the Twilio fake generates, in Twilio's own format (architecture.md 3.2): SIDs, and the
 * phone numbers the fake hands out, in E.164.
 */
export const TWILIO_IDS = idFormats("twilio", {
  account: sid("AC"),
  apiKey: sid("SK"),
  message: sid("SM"),
  messagingService: sid("MG"),
  phoneNumber: sid("PN"),
  // The id of one API request, on every answer (`Twilio-Request-Id`).
  request: sid("RQ"),
  // A webhook's `I-Twilio-Idempotency-Token`: the same on each retry of one request.
  idempotency: {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    generate: (draw) =>
      `${draw.chars(8, HEX)}-${draw.chars(4, HEX)}-${draw.chars(4, HEX)}-${draw.chars(4, HEX)}-${draw.chars(12, HEX)}`,
  },
  // A number the fake gives a person or the agent: a North American one in the range kept for
  // fiction (`555-0100` to `555-0199`), so no real phone ever has it. The area code doesn't start with 0 or 1.
  number: {
    pattern: /^\+1[2-9]\d{2}55501\d{2}$/,
    generate: (draw) => `+1${draw.chars(1, "23456789")}${draw.chars(2, DIGITS)}55501${draw.chars(2, DIGITS)}`,
  },
});
