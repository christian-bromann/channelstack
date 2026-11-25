import { spawnSync } from "node:child_process";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";

// A project with only the plugin and no `testTimeout` of its own: a check that fails after its
// default 10s wait reports its own message, not Vitest's "Test timed out in 5000ms" (the plugin
// raises the test timeout when a project doesn't set one).
test("a failing check reports its own message within the default config", async () => {
  const server = await startBinary({
    bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
    env: { CHANNELSTACK_LOG_LEVEL: "warn" },
  });
  try {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/default-timeout/vitest.config.ts",
        "--reporter",
        "verbose",
      ],
      { cwd: ROOT, env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" }, encoding: "utf8" },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(1);
    expect(output).toMatch(/1 failed/);
    expect(output).toContain("Expected a reply from my-agent. The thread has:");
    expect(output).not.toContain("Test timed out");
  } finally {
    await server.stop();
  }
}, 60_000);
