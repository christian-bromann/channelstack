import { HEX, idFormats, LOWER_ALNUM, UPPER_ALNUM } from "../../core/ids/index.ts";

/** Base 62, as OpenAI's ids use it. */
const BASE62 = `${UPPER_ALNUM}${LOWER_ALNUM.slice(10)}`;

/** OpenAI's items and objects: a prefix and 48 hex characters (`resp_…`, `msg_…`, `fc_…`, `rs_…`, `conv_…`). */
const hex48 = (prefix: string) => ({
  pattern: new RegExp(`^${prefix}_[0-9a-f]{48}$`),
  generate: (draw: { chars(length: number, alphabet: string): string }) => `${prefix}_${draw.chars(48, HEX)}`,
});

/**
 * Every id the fake OpenAI generates, in OpenAI's own format (architecture.md 3.2), and the
 * fake's own for its scripts and held calls, which OpenAI has no word for.
 */
export const OPENAI_IDS = idFormats("openai", {
  // A Chat Completion: `chatcmpl-` and 29 base-62 characters.
  chatCompletion: { pattern: /^chatcmpl-[0-9A-Za-z]{29}$/, generate: (draw) => `chatcmpl-${draw.chars(29, BASE62)}` },
  response: hex48("resp"),
  message: hex48("msg"),
  functionCall: hex48("fc"),
  customCall: hex48("ctc"),
  reasoning: hex48("rs"),
  conversation: hex48("conv"),
  // A tool call's id, as the model makes it: `call_` and 24 base-62 characters.
  call: { pattern: /^call_[0-9A-Za-z]{24}$/, generate: (draw) => `call_${draw.chars(24, BASE62)}` },
  // `x-request-id`: `req_` and 32 hex characters.
  request: { pattern: /^req_[0-9a-f]{32}$/, generate: (draw) => `req_${draw.chars(32, HEX)}` },
  fingerprint: { pattern: /^fp_[0-9a-f]{10}$/, generate: (draw) => `fp_${draw.chars(10, HEX)}` },
  organization: { pattern: /^org-[0-9A-Za-z]{24}$/, generate: (draw) => `org-${draw.chars(24, BASE62)}` },
  project: { pattern: /^proj_[0-9A-Za-z]{24}$/, generate: (draw) => `proj_${draw.chars(24, BASE62)}` },
  // The fake's own: a test's script, and a call it holds for a responder.
  script: { pattern: /^ms_[0-9a-z]{12}$/, generate: (draw) => `ms_${draw.chars(12, LOWER_ALNUM)}` },
  held: { pattern: /^mreq_[0-9a-z]{16}$/, generate: (draw) => `mreq_${draw.chars(16, LOWER_ALNUM)}` },
});
