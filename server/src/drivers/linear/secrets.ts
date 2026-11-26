import { alnum, hex, type SecretFormat } from "../../core/secrets/index.ts";

/** Every token and signing secret of the Linear platform the driver knows, in its own layout. */
export const LINEAR_SECRETS = {
  oauthToken: { pattern: /^lin_oauth_[a-f0-9]{64}$/, generate: () => `lin_oauth_${hex(64)}` },
  apiKey: { pattern: /^lin_api_[A-Za-z0-9]{40}$/, generate: () => `lin_api_${alnum(40)}` },
  // An OAuth app's client id and secret, as Linear shows them: 32 hex characters each.
  clientId: { pattern: /^[a-f0-9]{32}$/, generate: () => hex(32) },
  clientSecret: { pattern: /^[a-f0-9]{32}$/, generate: () => hex(32) },
  webhookSecret: { pattern: /^lin_wh_[A-Za-z0-9]{43}$/, generate: () => `lin_wh_${alnum(43)}` },
} as const satisfies Record<string, SecretFormat>;
