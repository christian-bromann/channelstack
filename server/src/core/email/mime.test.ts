import { describe, expect, test } from "vitest";

import { parseMime, withHeaders } from "./mime.ts";

describe("reading and stamping a message", () => {
  test("an encoded name with a comma in it is one mailbox's name", async () => {
    const raw = [
      "From: =?UTF-8?Q?Lima=2C_Ana?= <Ana@Example.com>",
      "To: =?UTF-8?Q?M=C3=BCller=2C_Ben?= <ben@example.com>, carla@example.com",
      "Cc: Team: dana@example.com;",
      "Subject: Hi",
      "",
      "Hello",
    ].join("\r\n");
    const parsed = await parseMime(raw);
    expect(parsed.from).toEqual({ address: "ana@example.com", name: "Lima, Ana" });
    expect(parsed.to).toEqual([
      { address: "ben@example.com", name: "Müller, Ben" },
      { address: "carla@example.com", name: "" },
    ]);
    expect(parsed.cc).toEqual([{ address: "dana@example.com", name: "" }]);
  });

  test("headers set replace the fields of their names, folded lines too, and leave the body alone", () => {
    const raw =
      "From: someone@elsewhere.example\r\nTo: ana@example.com\r\nX-Long: a\r\n b\r\nSubject: Hi\r\n\r\nFrom: not a header\r\n";
    expect(
      withHeaders(raw, { "Message-ID": "<1@mail.gmail.com>", From: "my-agent <a@acme.example>", "x-long": "c" }),
    ).toBe(
      "Message-ID: <1@mail.gmail.com>\r\nFrom: my-agent <a@acme.example>\r\nx-long: c\r\nTo: ana@example.com\r\nSubject: Hi\r\n\r\nFrom: not a header\r\n",
    );
  });
});
