import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { signEchoDelivery } from "./echo.ts";
import { constantTimeEqual, hmacSha256Hex } from "./hmac.ts";

describe("signing", () => {
  test("HMAC-SHA256 matches RFC 4231 test case 2", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  test("constant-time compare accepts equal values and rejects different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  test("an echo delivery is signed over the timestamp and the exact body", () => {
    const body = '{"type":"message.created"}';
    const headers = signEchoDelivery("s3cret", body, 1_732_101_234_567);
    const expected = createHmac("sha256", "s3cret").update(`v1:1732101234:${body}`).digest("hex");

    expect(headers).toEqual({ "x-echo-request-timestamp": "1732101234", "x-echo-signature": `v1=${expected}` });
    expect(signEchoDelivery("s3cret", `${body} `, 1_732_101_234_567)["x-echo-signature"]).not.toBe(`v1=${expected}`);
  });
});
