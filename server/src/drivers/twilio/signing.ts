import { hmacSha1Base64 } from "../../core/signing/hmac.ts";

/**
 * Twilio's `X-Twilio-Signature`: HMAC-SHA1 with the account's Auth Token over the URL Twilio
 * requested, then each POST parameter's name and value, sorted by name, in base64. The URL is the
 * one configured, without a fragment of connection overrides (`#rc=2`), which never leaves Twilio.
 */
export function twilioSignature(authToken: string, url: string, body: string): string {
  const params = new URLSearchParams(body);
  const names = [...new Set(params.keys())].sort();
  const signed = names.reduce(
    (text, name) =>
      text +
      params
        .getAll(name)
        .sort()
        .map((value) => `${name}${value}`)
        .join(""),
    url.split("#")[0] as string,
  );
  return hmacSha1Base64(authToken, signed);
}
