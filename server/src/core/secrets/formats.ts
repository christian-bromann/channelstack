import { randomString } from "./csprng.ts";

const DIGITS = "0123456789";
const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${DIGITS}${UPPER}${UPPER.toLowerCase()}`;
const UPPER_ALNUM = `${DIGITS}${UPPER}`;

interface SecretFormat {
  /** What the real platform's value looks like. */
  readonly pattern: RegExp;
  generate(): string;
}

const digits = (n: number) => randomString(n, DIGITS);
const hex = (n: number) => randomString(n, HEX);
const alnum = (n: number) => randomString(n, ALNUM);

/**
 * Every fake token and signing secret, in the platform's own layout (architecture.md 3.2).
 * Drivers name the formats they need; nothing else generates a secret.
 */
export const SECRET_FORMATS = {
  "slack.botToken": {
    pattern: /^xoxb-\d{13}-\d{13}-[A-Za-z0-9]{24}$/,
    generate: () => `xoxb-${digits(13)}-${digits(13)}-${alnum(24)}`,
  },
  "slack.userToken": {
    pattern: /^xoxp-\d{13}-\d{13}-\d{13}-[a-f0-9]{32}$/,
    generate: () => `xoxp-${digits(13)}-${digits(13)}-${digits(13)}-${hex(32)}`,
  },
  "slack.appToken": {
    pattern: /^xapp-1-A[A-Z0-9]{10}-\d{13}-[a-f0-9]{64}$/,
    generate: () => `xapp-1-A${randomString(10, UPPER_ALNUM)}-${digits(13)}-${hex(64)}`,
  },
  "slack.signingSecret": { pattern: /^[a-f0-9]{32}$/, generate: () => hex(32) },
  "github.webhookSecret": { pattern: /^[a-f0-9]{40}$/, generate: () => hex(40) },
  "github.installationToken": { pattern: /^ghs_[A-Za-z0-9]{36}$/, generate: () => `ghs_${alnum(36)}` },
  "linear.oauthToken": { pattern: /^lin_oauth_[a-f0-9]{64}$/, generate: () => `lin_oauth_${hex(64)}` },
  "linear.apiKey": { pattern: /^lin_api_[A-Za-z0-9]{40}$/, generate: () => `lin_api_${alnum(40)}` },
  "linear.webhookSecret": { pattern: /^lin_wh_[A-Za-z0-9]{43}$/, generate: () => `lin_wh_${alnum(43)}` },
  "notion.token": { pattern: /^ntn_[A-Za-z0-9]{46}$/, generate: () => `ntn_${alnum(46)}` },
  "notion.verificationToken": { pattern: /^secret_[A-Za-z0-9]{43}$/, generate: () => `secret_${alnum(43)}` },
  "echo.appToken": { pattern: /^echo_app_[A-Za-z0-9]{40}$/, generate: () => `echo_app_${alnum(40)}` },
  "echo.signingSecret": { pattern: /^[a-f0-9]{64}$/, generate: () => hex(64) },
} as const satisfies Record<string, SecretFormat>;

export type SecretFormatName = keyof typeof SECRET_FORMATS;
