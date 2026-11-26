import { DIGITS, HEX, idFormats, LOWER_ALNUM, numeric } from "../../core/ids/index.ts";

/**
 * Every id the Google fake generates, in Google's own format (architecture.md 3.2). Gmail's message
 * and thread ids are 16 hex characters, and its history ids decimal; Pub/Sub's message ids are 16
 * digits.
 */
/** The characters of a Gmail `Message-ID`'s local part. */
const MESSAGE_ID_CHARS = `${LOWER_ALNUM}ABCDEFGHIJKLMNOPQRSTUVWXYZ+-_`;

export const GOOGLE_IDS = idFormats("google", {
  // A message or thread id, as Gmail gives them now: `19` and 14 more hex characters.
  message: { pattern: /^[0-9a-f]{16}$/, generate: (draw) => `19${draw.chars(14, HEX)}` },
  thread: { pattern: /^[0-9a-f]{16}$/, generate: (draw) => `19${draw.chars(14, HEX)}` },
  // Where a mailbox's history starts: a 7-digit history id.
  history: numeric(1_000_000, 9_999_999, /^[1-9]\d{6,19}$/),
  // A Pub/Sub message's id: 16 digits.
  pushMessage: { pattern: /^[1-9]\d{15}$/, generate: (draw) => `1${draw.chars(15, DIGITS)}` },
  // A Google account's numeric id (`sub`), as the push service account's: 21 digits.
  account: { pattern: /^1\d{20}$/, generate: (draw) => `1${draw.chars(20, DIGITS)}` },
  // The local part of a `Message-ID` Gmail gives the mail it sends: `CA`, base-64 characters with
  // `+`, `-` and `_`, and an `=` within (`CAK6E+7-CYRns…=…`).
  messageLocal: {
    pattern: /^CA[0-9A-Za-z+_-]{28}=[0-9A-Za-z+_-]{10}$/,
    generate: (draw) => `CA${draw.chars(28, MESSAGE_ID_CHARS)}=${draw.chars(10, MESSAGE_ID_CHARS)}`,
  },
});
