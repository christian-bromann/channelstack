import { hmacSha256Base64, hmacSha256Hex } from "../../core/signing/hmac.ts";

/**
 * Resend's webhook headers, signed the way Svix signs (Standard Webhooks): HMAC-SHA256 with the
 * secret's key (`whsec_` taken off, base64-decoded) over `<id>.<timestamp>.<body>`, the exact bytes
 * sent. The timestamp is in seconds; receivers refuse one more than five minutes from theirs.
 */
export function signResendWebhook(secret: string, id: string, body: string, atMs: number): Record<string, string> {
  const timestamp = String(Math.floor(atMs / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${hmacSha256Base64(key, `${id}.${timestamp}.${body}`)}`,
  };
}

/**
 * A download link's signature, as Resend's CDN signs its links: over what the link opens and
 * when it stops working (`Expires`, in seconds). The fake checks it the same way when the link is used.
 */
export const resendDownloadSignature = (key: string, path: string, expires: number): string =>
  hmacSha256Hex(key, `${path}?Expires=${expires}`);
