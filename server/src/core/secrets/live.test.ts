import { inspect } from "node:util";

import { describe, expect, test } from "vitest";

import { LiveVault } from "./live.ts";

describe("live credentials", () => {
  test("a credential never turns into text by accident", () => {
    const vault = new LiveVault({ CHANNELSTACK_SLACK_BOT_TOKEN: "xoxb-1234567890-abcdef" }, () => {});
    const token = vault.fromEnv("CHANNELSTACK_SLACK_BOT_TOKEN");
    expect(token?.reveal()).toBe("xoxb-1234567890-abcdef");
    expect(JSON.stringify({ token })).toBe('{"token":"[redacted]"}');
    expect(`${token}`).toBe("[redacted]");
    expect(inspect(token)).toBe("[redacted]");
    expect(token?.prefix()).toBe("xoxb-");
  });

  test("every credential is registered with the redactor; a setting isn't", () => {
    const registered: string[] = [];
    const vault = new LiveVault(
      { CHANNELSTACK_SLACK_BOT_TOKEN: "xoxb-secret-value", CHANNELSTACK_SLACK_APP_ID: "A0APP" },
      (secret) => registered.push(secret),
    );
    vault.fromEnv("CHANNELSTACK_SLACK_BOT_TOKEN");
    const ana = vault.person("Ana Smith", "xoxp-person-value");
    expect(vault.setting("CHANNELSTACK_SLACK_APP_ID")).toBe("A0APP");
    expect(registered).toEqual(["xoxb-secret-value", "xoxp-person-value"]);
    // Whose it is, by the name the test gave: what the ledger records.
    expect(ana.owner).toBe("user:ANA_SMITH");
  });

  test("an unset or empty variable is no credential", () => {
    const vault = new LiveVault({ CHANNELSTACK_SLACK_BOT_TOKEN: "" }, () => {});
    expect(vault.fromEnv("CHANNELSTACK_SLACK_BOT_TOKEN")).toBeUndefined();
    expect(vault.fromEnv("CHANNELSTACK_NOTION_TOKEN")).toBeUndefined();
  });
});
