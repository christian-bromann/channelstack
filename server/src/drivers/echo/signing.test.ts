import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { signEchoDelivery } from "./signing.ts";

describe("echo signing", () => {
  test("an echo delivery is signed over the timestamp and the exact body", () => {
    const body = '{"type":"message.created"}';
    const headers = signEchoDelivery("s3cret", body, 1_732_101_234_567);
    const expected = createHmac("sha256", "s3cret").update(`v1:1732101234:${body}`).digest("hex");

    expect(headers).toEqual({ "x-echo-request-timestamp": "1732101234", "x-echo-signature": `v1=${expected}` });
    expect(signEchoDelivery("s3cret", `${body} `, 1_732_101_234_567)["x-echo-signature"]).not.toBe(`v1=${expected}`);
  });
});
