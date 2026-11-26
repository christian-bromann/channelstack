import { hmacSha256Hex } from "../../core/signing/hmac.ts";

/**
 * Linear's webhook signature (https://linear.app/developers/webhooks#securing-webhooks):
 * `Linear-Signature: <hex HMAC-SHA256 of the body>` with the webhook's signing secret, over the
 * exact bytes sent. The time is inside the signed body (`webhookTimestamp`), and receivers refuse
 * a delivery more than a minute old, so a redelivery is stamped and signed again.
 */
export function signLinearWebhook(webhookSecret: string, body: string, atMs: number): Record<string, string> {
  return { "linear-signature": hmacSha256Hex(webhookSecret, body), "linear-timestamp": String(atMs) };
}

/** The body with this attempt's `webhookTimestamp`: the field is replaced in place, so nothing else moves. */
export function stampLinearWebhook(body: string, atMs: number): string {
  return body.replace(/"webhookTimestamp":\d+/, `"webhookTimestamp":${atMs}`);
}
