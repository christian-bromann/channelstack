import { HEX, idFormats, LOWER_ALNUM, UPPER_ALNUM, uuid } from "../../core/ids/index.ts";

/**
 * Every id the Resend fake generates, in Resend's own format (architecture.md 3.2): emails,
 * domains, webhooks and API keys are UUIDs; a webhook message is Svix's `msg_…`.
 */
export const RESEND_IDS = idFormats("resend", {
  email: uuid,
  domain: uuid,
  webhook: uuid,
  attachment: uuid,
  // A webhook delivery's id (`svix-id`), as Svix makes them: `msg_` and 27 base-62 characters.
  message: {
    pattern: /^msg_[0-9A-Za-z]{27}$/,
    generate: (draw) => `msg_${draw.chars(27, `${UPPER_ALNUM}${LOWER_ALNUM.slice(10)}`)}`,
  },
  // The local part of a `Message-ID` of email Resend sends, as Amazon SES gives it: 16 hex
  // characters, a UUID and `-000000` (found against Resend), at `email.amazonses.com`.
  messageLocal: {
    pattern: /^[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-000000$/,
    generate: (draw) => `0100019a${draw.chars(8, HEX)}-${uuid.generate(draw)}-000000`,
  },
});
