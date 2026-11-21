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
    expect(quiet.state("ses_a", 0).busy).toBe(false);
  });
});
