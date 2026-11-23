import { hmacSha256Hex } from "./hmac.ts";

/**
 * Notion's webhook signature (https://developers.notion.com/reference/webhooks#validating-event-authenticity):
 * `X-Notion-Signature: sha256=<hex HMAC-SHA256 of the body>` with the subscription's verification
 * token, over the exact bytes sent.
 */
export function signNotionWebhook(verificationToken: string, body: string): Record<string, string> {
  return { "x-notion-signature": `sha256=${hmacSha256Hex(verificationToken, body)}` };
}
