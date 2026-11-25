import { idFormats, LOWER_ALNUM, UPPER_ALNUM, uuid } from "../../core/ids/index.ts";

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
  // The local part of a `Message-ID` Resend gives what it sends: lowercase, at the sending domain.
  messageLocal: {
    pattern: /^[0-9a-z]{24}$/,
    generate: (draw) => draw.chars(24, LOWER_ALNUM),
  },
});
