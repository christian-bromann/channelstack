import { alnum, digits, hex, randomString, type SecretFormat, UPPER_ALNUM } from "../../core/secrets/index.ts";

/** Every token and signing secret of the Slack platform the driver knows, in its own layout. */
export const SLACK_SECRETS = {
  botToken: {
    pattern: /^xoxb-\d{13}-\d{13}-[A-Za-z0-9]{24}$/,
    generate: () => `xoxb-${digits(13)}-${digits(13)}-${alnum(24)}`,
  },
  userToken: {
    pattern: /^xoxp-\d{13}-\d{13}-\d{13}-[a-f0-9]{32}$/,
    generate: () => `xoxp-${digits(13)}-${digits(13)}-${digits(13)}-${hex(32)}`,
  },
  appToken: {
    pattern: /^xapp-1-A[A-Z0-9]{10}-\d{13}-[a-f0-9]{64}$/,
    generate: () => `xapp-1-A${randomString(10, UPPER_ALNUM)}-${digits(13)}-${hex(64)}`,
  },
  signingSecret: { pattern: /^[a-f0-9]{32}$/, generate: () => hex(32) },
  // The deprecated verification token Slack still puts in every payload as `token`.
  verificationToken: { pattern: /^[A-Za-z0-9]{24}$/, generate: () => alnum(24) },
} as const satisfies Record<string, SecretFormat>;
