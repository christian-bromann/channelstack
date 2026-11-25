import { describe, expect, test } from "vitest";

import fixtures from "./mrkdwn.fixtures.json" with { type: "json" };
import { richTextElements } from "./mrkdwn.ts";

describe("Slack's rich_text block of a message's mrkdwn (#45)", () => {
  // Each case is a message real Slack was sent as text, and the block it made of it.
  test.each(fixtures.cases.map((c) => [c.text, c.elements] as const))("%j", (text, elements) => {
    expect(richTextElements(text)).toEqual(elements);
  });

  test("a long message parses in linear time", () => {
    const text = "*bold* _it_ :eyes: <@U0BOT0000> https://example.com ".repeat(2000);
    const started = performance.now();
    expect(richTextElements(text).length).toBe(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
