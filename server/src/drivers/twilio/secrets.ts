import { alnum, hex, type SecretFormat } from "../../core/secrets/index.ts";

/** Every token and secret of the Twilio platform the driver knows, in its own layout. */
export const TWILIO_SECRETS = {
  // An account's Auth Token: 32 hex characters. It signs the webhooks too.
  authToken: { pattern: /^[0-9a-f]{32}$/, generate: () => hex(32) },
  // An API key's secret, shown once when the key is made: 32 letters and digits.
  apiKeySecret: { pattern: /^[0-9A-Za-z]{32}$/, generate: () => alnum(32) },
  // The test credentials' Auth Token: with it the magic numbers do what Twilio documents, and nothing is sent.
  testAuthToken: { pattern: /^[0-9a-f]{32}$/, generate: () => hex(32) },
} as const satisfies Record<string, SecretFormat>;

/**
 * A live person's credential, `<Account SID>:<Auth Token>` (or an API key's `<SID>:<secret>`):
 * the account that owns their number. Never one the fake makes.
 */
export const TWILIO_PERSON_TOKEN: SecretFormat = {
  pattern: /^(?:AC|SK)[0-9a-f]{32}:[0-9A-Za-z]{32}$/,
  generate: () => `AC${hex(32)}:${hex(32)}`,
};
