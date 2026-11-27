import { describe, expect, test } from "vitest";

import { alnum, hex } from "../secrets/index.ts";
import { Redactor } from "./index.ts";

/** A made-up platform's token shape: each driver's own are tested in drivers/formats.test.ts. */
const PATTERNS = [/tok_[A-Za-z0-9]{20,}/g];
const token = () => `tok_${alnum(32)}`;

describe("redaction", () => {
  test("a token is scrubbed by its shape", () => {
    const value = token();
    const out = new Redactor(PATTERNS).text(`calling with ${value} failed`);
    expect(out).not.toContain(value);
    expect(out).toContain("[redacted]");
  });

  test("shapeless secrets are scrubbed once registered", () => {
    const secret = hex(32);
    const redactor = new Redactor(PATTERNS);
    expect(redactor.text(`secret=${secret}`)).toContain(secret);
    redactor.register(secret);
    expect(redactor.text(`secret=${secret}`)).toBe("secret=[redacted]");
  });

  test("bearer headers and emails are scrubbed from text", () => {
    const out = new Redactor(PATTERNS).text(
      `Authorization: Bearer abc.def-123456 from ana@example.com using ${token()}`,
    );
    expect(out).toBe("Authorization: Bearer [redacted] from [redacted] using [redacted]");
  });

  test("basic credentials are scrubbed from text: an account and its secret, in base64", () => {
    const basic = Buffer.from(`AC${"0".repeat(32)}:${"f".repeat(32)}`).toString("base64");
    expect(new Redactor(PATTERNS).text(`Authorization: Basic ${basic}`)).toBe("Authorization: Basic [redacted]");
    // Prose about it isn't a credential.
    expect(new Redactor(PATTERNS).text("use basic authentication")).toBe("use basic authentication");
  });

  test("an address in a URL is scrubbed too, and error data is scrubbed like text", () => {
    const redactor = new Redactor(PATTERNS);
    expect(redactor.text("GET /resend/users/ana.mar%40example.com/inbox")).toBe("GET /resend/users/[redacted]/inbox");
    expect(redactor.data({ id: "ana@example.com", path: ["/users/ana%40example.com"], n: 1 })).toEqual({
      id: "[redacted]",
      path: ["/users/[redacted]"],
      n: 1,
    });
  });

  test("recorded payloads keep ordinary text that mentions bearer tokens", () => {
    const redactor = new Redactor(PATTERNS);
    const said = { text: "please use bearer authentication", header: "Authorization: Bearer abcdefgh12345678" };
    expect(redactor.tokens(said)).toEqual(said);
    // A log line is not content: there, whatever follows `Bearer` is scrubbed.
    expect(redactor.text(said.header)).toBe("Authorization: Bearer [redacted]");
  });

  test("recorded payloads keep their content and lose only tokens", () => {
    const value = token();
    const recorded = new Redactor(PATTERNS).tokens({
      text: `mail ana@example.com`,
      nested: [{ token: value }],
      n: 1,
      none: null,
    });
    expect(recorded).toEqual({ text: "mail ana@example.com", nested: [{ token: "[redacted]" }], n: 1, none: null });
  });
});
