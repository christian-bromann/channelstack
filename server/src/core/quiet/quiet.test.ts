import { describe, expect, test } from "vitest";

import { QuietDetector } from "./index.ts";

describe("quiet detector", () => {
  test("a session is quiet for as long as nothing has happened in it", () => {
    let now = 1000;
    const quiet = new QuietDetector(() => now);
    expect(quiet.state("ses_a", 0)).toEqual({ busy: false, quietForMs: Number.MAX_SAFE_INTEGER });

    quiet.touch("ses_a");
    now += 400;
    expect(quiet.state("ses_a", 0)).toEqual({ busy: false, quietForMs: 400 });
    quiet.touch("ses_a");
    expect(quiet.state("ses_a", 0).quietForMs).toBe(0);
    // Other sessions keep their own clock.
    expect(quiet.state("ses_b", 0).quietForMs).toBe(Number.MAX_SAFE_INTEGER);
    quiet.forget("ses_a");
    expect(quiet.state("ses_a", 0).quietForMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("open work or a call in flight means busy, however long ago the last event was", async () => {
    let now = 0;
    const quiet = new QuietDetector(() => now);
    quiet.touch("ses_a");
    now += 5000;
    expect(quiet.state("ses_a", 1)).toEqual({ busy: true, quietForMs: 0 });

    let release = () => {};
    const call = quiet.during(() => new Promise<string>((resolve) => (release = () => resolve("done"))));
    expect(quiet.state("ses_a", 0).busy).toBe(true);
    release();
    expect(await call).toBe("done");
    expect(quiet.state("ses_a", 0)).toEqual({ busy: false, quietForMs: 5000 });

    await expect(quiet.during(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    // Told to retry in a second: busy until then, quiet after.
    quiet.expectMore("ses_a", "chat.postMessage", 1000);
    now += 900;
    expect(quiet.state("ses_a", 0).busy).toBe(true);
    now += 200;
    // Quiet counts from the end of that window, not from the event before it.
    expect(quiet.state("ses_a", 0)).toEqual({ busy: false, quietForMs: 100 });

    // The retry arrives early: the wait ends there, and quiet counts from the retry.
    quiet.expectMore("ses_a", "chat.postMessage", 5000);
    now += 1500;
    quiet.touch("ses_a");
    quiet.arrived("ses_a", "chat.postMessage");
    now += 300;
    expect(quiet.state("ses_a", 0)).toEqual({ busy: false, quietForMs: 300 });
  });
});
