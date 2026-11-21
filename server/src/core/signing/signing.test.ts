import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { signEchoDelivery } from "./echo.ts";
import { constantTimeEqual, hmacSha256Hex } from "./hmac.ts";
import { signSlackRequest } from "./slack.ts";

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

  test("a Slack request is signed the way Slack documents it", () => {
    // The worked example from Slack's "Verifying requests from Slack".
    const secret = "8f742231b10e8888abcd99yyyzzz85a5";
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(signSlackRequest(secret, body, 1_531_420_618_000)).toEqual({
      "x-slack-request-timestamp": "1531420618",
      "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    });
  });

  test("an echo delivery is signed over the timestamp and the exact body", () => {
    const body = '{"type":"message.created"}';
    const headers = signEchoDelivery("s3cret", body, 1_732_101_234_567);
    const expected = createHmac("sha256", "s3cret").update(`v1:1732101234:${body}`).digest("hex");

    expect(headers).toEqual({ "x-echo-request-timestamp": "1732101234", "x-echo-signature": `v1=${expected}` });
    expect(signEchoDelivery("s3cret", `${body} `, 1_732_101_234_567)["x-echo-signature"]).not.toBe(`v1=${expected}`);
  });
});
