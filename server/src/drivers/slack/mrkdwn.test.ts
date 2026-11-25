import { describe, expect, test } from "vitest";

import fixtures from "./mrkdwn.fixtures.json" with { type: "json" };
import { richTextElements } from "./mrkdwn.ts";

describe("Slack's rich_text block of a message's mrkdwn (#45)", () => {
  // Each case is a message real Slack was sent as text, and the block it made of it.
  test.each(fixtures.cases.map((c) => [c.text, c.elements] as const))("%j", (text, elements) => {
    expect(richTextElements(text)).toEqual(elements);
  });

  // A message is at most 40,000 characters. Inputs that make a naive parser rescan the rest of the
  // line at each character took over a second at that length; a linear pass takes milliseconds.
  test.each([
    ["openers that never close", "*a ".repeat(13_333)],
    ["one long email-like run", "a-".repeat(20_000)],
    ["`<` that never closes", "<".repeat(40_000)],
    ["colons", ":a".repeat(20_000)],
    ["markers nested 6,000 deep", `${"*a ".repeat(6_000)}${"a* ".repeat(6_000)}`],
    ["every kind at once", "_x *y ~z `w <@U0 https://a.example ".repeat(1_100)],
  ])("%s, at the length limit, parses quickly", (_, text) => {
    const started = performance.now();
    richTextElements(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
