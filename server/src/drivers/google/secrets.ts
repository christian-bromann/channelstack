import { alnum, digits, randomRsaPrivateKey, randomString, type SecretFormat } from "../../core/secrets/index.ts";

/** What OAuth tokens and secrets are made of: base-64-url's characters. */
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Every credential of the Google platform the driver knows, in its own layout. */
export const GOOGLE_SECRETS = {
  // The agent's OAuth client: `<project number>-<32 characters>.apps.googleusercontent.com`.
  clientId: {
    pattern: /^\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com$/,
    generate: () =>
      `${digits(12)}-${randomString(32, "abcdefghijklmnopqrstuvwxyz0123456789")}.apps.googleusercontent.com`,
  },
  clientSecret: { pattern: /^GOCSPX-[A-Za-z0-9_-]{28}$/, generate: () => `GOCSPX-${randomString(28, URL_SAFE)}` },
  // A refresh token for the agent's mailbox: `1//0` and the rest.
  refreshToken: {
    pattern: /^1\/\/0[A-Za-z0-9_-]{98}$/,
    generate: () => `1//0${alnum(2)}${randomString(96, URL_SAFE)}`,
  },
  // The key Google signs its Pub/Sub push tokens with: the fake's own, whose certificate it serves.
  pushKey: {
    pattern: /^-----BEGIN RSA PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END RSA PRIVATE KEY-----\n$/,
    generate: randomRsaPrivateKey,
  },
  // An access token, as the token endpoint hands them out: `ya29.` and the rest. Made per refresh.
  accessToken: { pattern: /^ya29\.[A-Za-z0-9_-]{150}$/, generate: () => `ya29.${randomString(150, URL_SAFE)}` },
} as const satisfies Record<string, SecretFormat>;
