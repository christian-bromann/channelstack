import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";

// #49: the browser actor started from source but not in the compiled binary, whose minifier renamed
// what WebdriverIO reads to tell a browser from an element. Built the way the binary is
// (`scripts/bun-compile.ts`, without `--compile`), it must still start Chrome.
test("the browser actor starts when bundled the way the binary is", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "channelstack-bundle-"));
  try {
    const built = spawnSync(
      "bun",
      [
        join(ROOT, "scripts", "bun-compile.ts"),
        join(ROOT, "test", "acceptance", "stand-ins", "browser-actor.ts"),
        "--bundle",
        dir,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(built.status, built.stderr).toBe(0);
    const ran = spawnSync("bun", [join(dir, "browser-actor.js")], { cwd: ROOT, encoding: "utf8", timeout: 110_000 });
    expect(ran.stdout + ran.stderr).toContain("started");
    expect(ran.status, ran.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
