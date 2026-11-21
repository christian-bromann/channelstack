import { describe, expect, test } from "vitest";

import { SECRET_FORMATS } from "../secrets/index.ts";
import { Redactor } from "./index.ts";

describe("redaction", () => {
  test.each(
    // Secrets with no prefix have no shape to recognise; they are scrubbed once registered (next test).
    Object.entries(SECRET_FORMATS).filter(([, format]) => /^\/\^[a-z_]+[-_]/.test(String(format.pattern))),
  )("a %s is scrubbed by its shape", (_name, format) => {
    const token = format.generate();
    const out = new Redactor().text(`calling with ${token} failed`);
    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
  });

  test("shapeless secrets are scrubbed once registered", () => {
    const secret = SECRET_FORMATS["slack.signingSecret"].generate();
    const redactor = new Redactor();
    expect(redactor.text(`secret=${secret}`)).toContain(secret);
    redactor.register(secret);
    expect(redactor.text(`secret=${secret}`)).toBe("secret=[redacted]");
  });

  test("bearer headers, live-shaped tokens and emails are scrubbed from text", () => {
    const pat = ["github", "pat", "11ABCDEFG0abcdefghijkl", "mnopqrstuvwxyz"].join("_");
    const out = new Redactor().text(`Authorization: Bearer abc.def-123456 from ana@example.com using ${pat}`);
    expect(out).toBe("Authorization: Bearer [redacted] from [redacted] using [redacted]");
  });

  test("recorded payloads keep ordinary text that mentions bearer tokens", () => {
    const redactor = new Redactor();
    const said = { text: "please use bearer authentication", header: "Authorization: Bearer abcdefgh12345678" };
    expect(redactor.tokens(said)).toEqual(said);
    // A log line is not content: there, whatever follows `Bearer` is scrubbed.
    expect(redactor.text(said.header)).toBe("Authorization: Bearer [redacted]");
  });

  test("recorded payloads keep their content and lose only tokens", () => {
    const token = SECRET_FORMATS["slack.botToken"].generate();
    const recorded = new Redactor().tokens({ text: `mail ana@example.com`, nested: [{ token }], n: 1, none: null });
    expect(recorded).toEqual({ text: "mail ana@example.com", nested: [{ token: "[redacted]" }], n: 1, none: null });
  });
});
