import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

/** Who signs Gmail's pushes: Google's accounts, as `verifyIdToken` checks the issuer. */
const PUSH_ISSUER = "https://accounts.google.com";
/** A push token is good for an hour, as Pub/Sub's are. */
export const PUSH_TOKEN_LIFETIME_S = 3600;

/** The id of a signing key, as Google names them in its certificates (`kid`): 40 hex characters. */
export function keyIdOf(privateKey: string): string {
  const spki = createPublicKey(createPrivateKey(privateKey)).export({ type: "spki", format: "der" });
  return createHash("sha1").update(spki).digest("hex");
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The claims of a push's OIDC token: for `audience`, from the push service account, issued at `atMs`. */
export interface PushClaims {
  readonly audience: string;
  readonly email: string;
  readonly subject: string;
  readonly atMs: number;
}

/**
 * The `Authorization` header of a Pub/Sub push: an RS256 OIDC token, signed with `privateKey` and
 * named by `keyId`, the id of the key the certificates serve (a token signed with another key
 * still names it: that is a bad signature, not an unknown key).
 */
export function signPushToken(privateKey: string, keyId: string, claims: PushClaims): Record<string, string> {
  const iat = Math.floor(claims.atMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      aud: claims.audience,
      azp: claims.subject,
      email: claims.email,
      email_verified: true,
      exp: iat + PUSH_TOKEN_LIFETIME_S,
      iat,
      iss: PUSH_ISSUER,
      sub: claims.subject,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return { authorization: `Bearer ${header}.${payload}.${signature}` };
}
