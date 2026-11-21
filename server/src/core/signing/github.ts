import { createPublicKey } from "node:crypto";

import { importSPKI, jwtVerify } from "jose";

import { hmacHex } from "./hmac.ts";

/**
 * GitHub's webhook signatures (https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries):
 * `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>` with the webhook secret, over the exact
 * bytes sent, and the older SHA-1 header GitHub still sends next to it.
 */
export function signGitHubWebhook(webhookSecret: string, body: string): Record<string, string> {
  return {
    "x-hub-signature": `sha1=${hmacHex("sha1", webhookSecret, body)}`,
    "x-hub-signature-256": `sha256=${hmacHex("sha256", webhookSecret, body)}`,
  };
}

/**
 * Check the JWT a GitHub App authenticates with: RS256 with the App's private key, `iss` the App's
 * id (or client id), not expired, and good for at most ten minutes. Resolves false for anything else.
 */
export async function verifyGitHubAppJwt(
  token: string,
  app: { privateKey: string; issuers: readonly string[] },
  atMs: number,
): Promise<boolean> {
  try {
    const spki = createPublicKey(app.privateKey).export({ type: "spki", format: "pem" }).toString();
    const { payload } = await jwtVerify(token, await importSPKI(spki, "RS256"), {
      algorithms: ["RS256"],
      currentDate: new Date(atMs),
      // GitHub allows some clock drift; Octokit backdates `iat` by 30 seconds for it.
      clockTolerance: 60,
    });
    const { iss, iat, exp } = payload;
    if (typeof iss !== "string" && typeof iss !== "number") return false;
    if (typeof exp !== "number" || typeof iat !== "number") return false;
    return app.issuers.includes(String(iss)) && exp - iat <= 10 * 60 + 60;
  } catch {
    return false;
  }
}
