import { alnum, hex, type SecretFormat } from "../../core/secrets/index.ts";

/** Every token and signing secret of the Echo platform the driver knows, in its own layout. */
export const ECHO_SECRETS = {
  appToken: { pattern: /^echo_app_[A-Za-z0-9]{40}$/, generate: () => `echo_app_${alnum(40)}` },
  signingSecret: { pattern: /^[a-f0-9]{64}$/, generate: () => hex(64) },
} as const satisfies Record<string, SecretFormat>;
