import { describe, expect, test } from "vitest";

import { htmlToText, threadTranscript } from "./index.ts";

const ana = { id: "U1", name: "Ana Lima", kind: "user" } as const;

/** What a transcript shows of one email. */
const read = (message: { text?: string; html?: string }): string =>
  threadTranscript([
    { id: "m1", author: ana, at: "2026-12-01T10:00:00.000Z", text: message.text, html: message.html, attachments: [] },
  ]).entries[0]?.text ?? "";

describe("an HTML-only email as a person reads it", () => {
  test("lists are items on lines of their own, bulleted and numbered", () => {
    expect(
      read({ html: "<p>Steps:</p><ul><li>Install</li><li>Run</li></ul><ol><li>First</li><li>Second</li></ol>" }),
    ).toBe("Steps:\n\n- Install\n- Run\n\n 1. First\n 2. Second");
  });

  test("a link reads as its text and its address, the address once when it is the text", () => {
    expect(
      read({
        html: '<p>See <a href="https://example.com/docs">the docs</a> or <a href="https://example.com">https://example.com</a>.</p>',
      }),
    ).toBe("See the docs [https://example.com/docs] or https://example.com.");
  });

  test("entities are decoded, named and numeric, and a no-break space is a space", () => {
    expect(read({ html: "<p>&copy; 2026 &mdash; caf&eacute; &lt;b&gt; &amp; &#x1F600; &#8364;5&nbsp;off</p>" })).toBe(
      "© 2026 — café <b> & 😀 €5 off",
    );
  });

  test("long lines aren't wrapped, and headings, scripts, styles and images are as a person sees them", () => {
    const sentence = "A sentence that runs well past eighty characters, which is where a wrapping converter breaks it.";
    expect(
      read({
        html: `<h1>Release notes</h1><p>${sentence}</p><img src="https://example.com/pixel.gif" alt=""><script>track()</script><style>p { color: red }</style>`,
      }),
    ).toBe(`Release notes\n\n${sentence}`);
  });

  test("a layout table's rows and cells are lines, and a linked image reads as its alt text", () => {
    const html =
      '<table><tr><td><a href="https://click.example/t/1"><img src="https://cdn.example/logo.png" alt="Acme"></a></td></tr>' +
      "<tr><td><h1>Welcome, Ana</h1></td></tr><tr><td>Your code is</td><td><b>123456</b></td></tr></table>";
    expect(read({ html })).toBe("Acme [https://click.example/t/1]\n\nWelcome, Ana\n\nYour code is\n123456");
  });

  test("without link addresses, a link is its text", () => {
    expect(htmlToText('<p>See <a href="https://example.com/docs">the docs</a>.</p>', { links: false })).toBe(
      "See the docs.",
    );
  });

  test("a Gmail reply is its own words, without the quoted history", () => {
    const html =
      '<div dir="ltr">Thanks, that worked.<br></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
      "On Mon, 1 Dec 2026 at 10:00, Ana Lima &lt;ana@example.com&gt; wrote:<br></div>" +
      '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">Can you <b>help</b>?<br>It fails.</blockquote></div>';
    expect(read({ html })).toBe("Thanks, that worked.");
  });

  test("the text part is read when there is one, its quoted history folded too", () => {
    expect(
      read({
        text: "Sure.\n\nOn Mon, 1 Dec 2026 at 10:00, Ana Lima <ana@example.com> wrote:\n> Can you help?",
        html: "<p>ignored</p>",
      }),
    ).toBe("Sure.");
  });
});
