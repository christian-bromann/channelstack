import { hmacSha256Hex } from "../../core/signing/hmac.ts";

/**
 * Slack's request signature (https://docs.slack.dev/authentication/verifying-requests-from-slack):
 * `v0=<HMAC-SHA256 of "v0:<timestamp>:<body>">` with the app's signing secret, over the exact bytes sent.
 * Receivers reject a timestamp more than five minutes old.
 */
export function signSlackRequest(signingSecret: string, body: string, atMs: number): Record<string, string> {
  const timestamp = String(Math.floor(atMs / 1000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:${body}`)}`,
  };
}
