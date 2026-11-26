import { alnum, type SecretFormat } from "../../core/secrets/index.ts";

/** Every token and signing secret of the Notion platform the driver knows, in its own layout. */
export const NOTION_SECRETS = {
  token: { pattern: /^ntn_[A-Za-z0-9]{46}$/, generate: () => `ntn_${alnum(46)}` },
  verificationToken: { pattern: /^secret_[A-Za-z0-9]{43}$/, generate: () => `secret_${alnum(43)}` },
} as const satisfies Record<string, SecretFormat>;
