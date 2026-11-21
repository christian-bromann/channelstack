import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 over the exact bytes that are sent, as lowercase hex. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Compare two secrets or signatures without leaking where they differ, or how long they are. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
