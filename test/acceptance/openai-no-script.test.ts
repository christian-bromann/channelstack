import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";

// Exit check 13.4: a model call no script answers fails the test, at once in a waiting matcher
// (well before its 20s timeout), and when the session closes in a test that asserts nothing. The
// two tests in `stand-ins/openai-no-script` run through the Vitest integration, unchanged, and must
// both fail, each with the reason.
test("an unscripted model call fails the test, at once or when its session closes", async () => {
  const server = await startBinary({
    bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
    env: { CHANNELSTACK_LOG_LEVEL: "warn" },
  });
  try {
    const started = Date.now();
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/stand-ins/openai-no-script/vitest.config.ts",
        "--reporter",
        "verbose",
      ],
      { cwd: ROOT, env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" }, encoding: "utf8" },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).not.toBe(0);
    expect(output).toMatch(/2 failed/);
    expect(output).toMatch(
      /a waiting matcher fails at once[\s\S]*no openai\.respond\(…\) in this test answers this call/,
    );
    expect(output).toMatch(/a test that asserts nothing still fails[\s\S]*The model calls of this test went wrong/);
    // The waiting matcher gave up on the problem, not on its 20s timeout.
    expect(Date.now() - started).toBeLessThan(20_000);
  } finally {
    await server.stop();
  }
}, 60_000);
