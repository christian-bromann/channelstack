import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** An HMAC over the exact bytes that are sent, as lowercase hex. */
export function hmacHex(algorithm: "sha256" | "sha1", secret: string, payload: string): string {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

/** HMAC-SHA256 over the exact bytes that are sent, as lowercase hex. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return hmacHex("sha256", secret, payload);
}

/** HMAC-SHA256 with a binary key (a secret that is base64 of random bytes, as Svix's are), as base64. */
export function hmacSha256Base64(key: Uint8Array, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64");
}

/** Compare two secrets or signatures without leaking where they differ, or how long they are. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
