import { describe, expect, test } from "vitest";

import { mentionedUsers, resolveMentions } from "./mentions.ts";

const ids: Record<string, string> = { "my-agent": "U0AGENT0001", ana: "U0ANA000001", "ana.b": "U0ANAB00001" };
const resolve = (text: string) => resolveMentions(text, (name) => ids[name]);

describe("mentions", () => {
  test("@name becomes a Slack mention of that person or app", () => {
    expect(resolve("@my-agent summarize #812")).toBe("<@U0AGENT0001> summarize #812");
    expect(resolve("thanks @ana, and @my-agent too")).toBe("thanks <@U0ANA000001>, and <@U0AGENT0001> too");
  });

  test("punctuation after a name isn't part of it, and the longest name wins", () => {
    expect(resolve("ping @my-agent.")).toBe("ping <@U0AGENT0001>.");
    expect(resolve("cc @ana.b and @ana.")).toBe("cc <@U0ANAB00001> and <@U0ANA000001>.");
  });

  test("@@ is a literal @, and unknown names are left alone", () => {
    expect(resolve("mail me @@home, @nobody")).toBe("mail me @home, @nobody");
    expect(resolve("user@example.com")).toBe("user@example.com");
  });

  test("mentioned users are read back from mrkdwn", () => {
    expect(mentionedUsers("<@U0AGENT0001> and <@U0ANA000001|ana> but not <#C123>")).toEqual([
      "U0AGENT0001",
      "U0ANA000001",
    ]);
  });
});
