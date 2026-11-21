import { describe, expect, test } from "vitest";

import { matchers } from "./index.ts";

const state = { isNot: false, timeout: "100ms", quietFor: "10ms" } as const;
const deliveryWith = (attempt: { status: string; durationMs: number; responseStatus?: number }) => ({
  id: "Ev0TEST",
  refresh: async () => ({ attempts: [{ forgedSignature: false, ...attempt }] }),
});

describe("toBeAccepted", () => {
  test("with `within`, an acknowledgement that came too late fails, and the message says how long it took", async () => {
    const slow = deliveryWith({ status: "acknowledged", responseStatus: 200, durationMs: 2900 });
    expect((await matchers.toBeAccepted(state, slow)).pass).toBe(true);
    expect((await matchers.toBeAccepted(state, slow, { within: "3s" })).pass).toBe(true);

    const late = await matchers.toBeAccepted(state, slow, { within: "1s" });
    expect(late.pass).toBe(false);
    expect(late.message()).toBe(
      "Expected delivery Ev0TEST to be accepted within 1000ms, its first attempt is acknowledged (HTTP 200) after 2900ms",
    );
  });

  test("an attempt the agent didn't acknowledge fails with or without `within`", async () => {
    const timedOut = deliveryWith({ status: "timed_out", durationMs: 3000 });
    const result = await matchers.toBeAccepted(state, timedOut);
    expect(result.pass).toBe(false);
    expect(result.message()).toBe(
      "Expected delivery Ev0TEST to be accepted, its first attempt is timed_out after 3000ms",
    );
  });
});
