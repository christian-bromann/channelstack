import { randomBytes } from "node:crypto";

import { alnum, type SecretFormat } from "../../core/secrets/index.ts";

/** Every key and signing secret of the Resend platform the driver knows, in its own layout. */
export const RESEND_SECRETS = {
  // An API key, as Resend shows one once: `re_`, 8 characters, `_`, 24 more.
  apiKey: { pattern: /^re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}$/, generate: () => `re_${alnum(8)}_${alnum(24)}` },
  // A webhook's signing secret, as Svix makes them: `whsec_` and base64 of 24 random bytes.
  webhookSecret: {
    pattern: /^whsec_[A-Za-z0-9+/]{32}$/,
    generate: () => `whsec_${randomBytes(24).toString("base64")}`,
  },
} as const satisfies Record<string, SecretFormat>;
