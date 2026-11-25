import { describe, expect, test } from "vitest";

import channelstack, { defaultTestTimeout } from "./index.ts";

/** What the plugin's `config` hook leaves in a project's `test` settings. */
const configured = (options: Parameters<typeof channelstack>[0], test: { testTimeout?: number } = {}) => {
  const config = { test: { ...test } as { setupFiles?: string | string[]; testTimeout?: number } };
  channelstack(options).config(config);
  return config.test;
};

describe("the test timeout", () => {
  test("a project that sets none gets one well above a check's own wait, not Vitest's 5s", () => {
    expect(configured({}).testTimeout).toBe(30_000);
    expect(defaultTestTimeout({})).toBeGreaterThan(10_000 + 750);
    // A longer timeout gets three times as long.
    expect(configured({ timeout: "20s", quietFor: "1s" }).testTimeout).toBe(60_000);
  });

  test("a project's own testTimeout always wins", () => {
    expect(configured({ timeout: "20s" }, { testTimeout: 5_000 }).testTimeout).toBe(5_000);
  });
});
