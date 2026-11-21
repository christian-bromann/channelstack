import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";

// Exit check 1.4: a real bug is caught. The stream-and-status example, unchanged, runs against an
// agent that leaves a lone "Thinking…" behind, and must fail with a message that names it.
test("the stream and status example fails against the mdac-220 agent and names the leftover message", async () => {
  let run: { status: number | null; output: string } | undefined;
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", "mdac-220", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
    },
    ({ env }) => {
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--config",
          "test/acceptance/vitest.config.ts",
          "-t",
          "streams a reply and shows a status while working",
        ],
        { cwd: ROOT, env: { ...env, NO_COLOR: "1" }, encoding: "utf8" },
      );
      run = { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
  );

  expect(run?.status).toBe(1);
  expect(run?.output).toContain("1 failed");
  // The failure says what a person is still looking at.
  expect(run?.output).toContain('Still open: a stream my-agent started and never stopped: "Thinking…"');
}, 60_000);
