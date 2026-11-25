import { alnum, hex, randomRsaPrivateKey, type SecretFormat } from "../../core/secrets/index.ts";

/** Every token and signing secret of the GitHub platform the driver knows, in its own layout. */
export const GITHUB_SECRETS = {
  webhookSecret: { pattern: /^[a-f0-9]{40}$/, generate: () => hex(40) },
  // The App's private key: the agent signs its JWTs with it, and the fake checks them against its public half.
  privateKey: {
    pattern: /^-----BEGIN RSA PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END RSA PRIVATE KEY-----\n$/,
    generate: randomRsaPrivateKey,
  },
  installationToken: { pattern: /^ghs_[A-Za-z0-9]{36}$/, generate: () => `ghs_${alnum(36)}` },
  // A fine-grained personal access token: what a person's live GitHub token looks like.
  personalToken: {
    pattern: /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/,
    generate: () => `github_pat_${alnum(22)}_${alnum(59)}`,
  },
} as const satisfies Record<string, SecretFormat>;
