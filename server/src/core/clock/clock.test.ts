import { describe, expect, test } from "vitest";

import { pollUntil, type Timers } from "./index.ts";

/** Time that passes only when a poll waits: each wait moves the clock on by its delay. */
function steppedTime() {
  let now = 0;
  const timers: Timers = {
    after(delayMs, task) {
      now += delayMs;
      queueMicrotask(task);
      return () => {};
    },
  };
  return { clock: () => now, timers };
}

describe("pollUntil", () => {
  test("answers as soon as there is an answer, asking every interval until then", async () => {
    const time = steppedTime();
    let asked = 0;
    const answer = await pollUntil(
      time,
      { withinMs: 10_000, everyMs: 1_000 },
      async () => (++asked === 3 ? "ok" : undefined),
      () => new Error("late"),
    );
    expect(answer).toBe("ok");
    expect(asked).toBe(3);
    expect(time.clock()).toBe(2_000);
  });

  test("gives up once the time is over, with the caller's error, having asked a last time at the deadline", async () => {
    const time = steppedTime();
    let asked = 0;
    const late = new Error("nothing came");
    await expect(
      pollUntil(
        time,
        { withinMs: 3_000, everyMs: 1_000 },
        async () => {
          asked++;
          return undefined;
        },
        () => late,
      ),
    ).rejects.toBe(late);
    expect(asked).toBe(4);
  });
});
