import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";

/** What comes before an Ed25519 seed in a PKCS#8 private key (RFC 8410). */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The private key an Ed25519 seed (32 bytes, as hex) stands for. */
function privateKeyOf(seed: string): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed, "hex")]),
    format: "der",
    type: "pkcs8",
  });
}

/** The app's public key, as Discord shows it in the developer portal: the key's 32 bytes, as hex. */
export function publicKeyOf(seed: string): string {
  const spki = createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" });
  return spki.subarray(-32).toString("hex");
}

/**
 * The headers Discord signs an interaction with: Ed25519 over the timestamp (seconds) followed by
 * the exact body, in `X-Signature-Ed25519` as hex, with the timestamp in `X-Signature-Timestamp`.
 */
export function signInteraction(seed: string, body: string, atMs: number): Record<string, string> {
  const timestamp = String(Math.floor(atMs / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKeyOf(seed)).toString("hex");
  return { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp };
}
