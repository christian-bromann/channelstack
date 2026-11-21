import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";

/** The only source of randomness for anything secret. Ids use the seeded source in `core/ids` instead. */

/** `length` characters drawn uniformly from `alphabet`. */
export function randomString(length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** A URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A 32-bit seed for runs that don't set `CHANNELSTACK_SEED`. */
export function randomSeed(): number {
  return randomInt(0x1_0000_0000);
}

/** A new RSA private key in PEM (PKCS#1), the form GitHub hands out for an App. */
export function randomRsaPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}
