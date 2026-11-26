import { hmacSha256Hex } from "../../core/signing/hmac.ts";

/**
 * The echo platform's delivery signature: `v1=<HMAC-SHA256 of "v1:<timestamp>:<body>">`,
 * sent with the timestamp so a receiver can reject replays.
 */
export function signEchoDelivery(secret: string, body: string, atMs: number): Record<string, string> {
  const timestamp = String(Math.floor(atMs / 1000));
  return {
    "x-echo-request-timestamp": timestamp,
    "x-echo-signature": `v1=${hmacSha256Hex(secret, `v1:${timestamp}:${body}`)}`,
  };
}
