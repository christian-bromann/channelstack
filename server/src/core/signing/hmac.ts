import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** An HMAC over the exact bytes that are sent, as lowercase hex. */
export function hmacHex(algorithm: "sha256" | "sha1", secret: string, payload: string): string {
  return createHmac(algorithm, secret).update(payload).digest("hex");
}

/** HMAC-SHA256 over the exact bytes that are sent, as lowercase hex. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return hmacHex("sha256", secret, payload);
}

/** Compare two secrets or signatures without leaking where they differ, or how long they are. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
