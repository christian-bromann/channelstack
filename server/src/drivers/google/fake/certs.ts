// @peculiar/x509 resolves its parts through tsyringe, which needs the Reflect metadata API first.
import "reflect-metadata";

import { createPrivateKey, createPublicKey } from "node:crypto";

import * as x509 from "@peculiar/x509";

/** Google names its push certificates' subject and issuer so. */
const SUBJECT = "CN=federated-signon.system.gserviceaccount.com";
const DAY_MS = 24 * 3_600_000;
/** Google rotates its keys every couple of weeks; a certificate here is made at each start. */
const VALID_DAYS = 14;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** The certificates `verifyIdToken` checks push tokens with, for one key: PEM (v1) and JWK (v3). */
export interface PushCertificates {
  /** `GET /oauth2/v1/certs`: `{ <kid>: <PEM certificate> }`. */
  readonly pem: Readonly<Record<string, string>>;
  /** `GET /oauth2/v3/certs`: `{ keys: [<JWK>] }`. */
  readonly jwk: { readonly keys: ReadonlyArray<Record<string, unknown>> };
}

/** A self-signed certificate for the push key, and the key as a JWK, both named by `keyId`. */
export async function pushCertificates(privateKey: string, keyId: string, now: number): Promise<PushCertificates> {
  const key = createPrivateKey(privateKey);
  const keys = {
    privateKey: await crypto.subtle.importKey("pkcs8", key.export({ type: "pkcs8", format: "der" }), RS256, true, [
      "sign",
    ]),
    publicKey: await crypto.subtle.importKey(
      "spki",
      createPublicKey(key).export({ type: "spki", format: "der" }),
      RS256,
      true,
      ["verify"],
    ),
  };
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    name: SUBJECT,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + VALID_DAYS * DAY_MS),
    keys,
    signingAlgorithm: RS256,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const { n, e } = createPublicKey(key).export({ format: "jwk" });
  return {
    pem: { [keyId]: `${certificate.toString("pem")}\n` },
    jwk: { keys: [{ e, kid: keyId, kty: "RSA", alg: "RS256", use: "sig", n }] },
  };
}
