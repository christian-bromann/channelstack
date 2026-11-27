import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";

// Exit check 2.2: Socket Mode works with Bolt. The same Bolt agent, started in Socket Mode, connects
// out to the fake; the DM examples, the interaction examples (the modal among them) and the
// reconnect example run against it unchanged.
const EXAMPLES = [
  "direct messages > ",
  "buttons, menus, modals and commands > ",
  "delivery and failures \\(fake only\\) > reconnects after the Socket Mode connection drops",
];

test("the DM, modal and reconnect examples pass against the Bolt agent in Socket Mode", async () => {
  let run: { status: number | null; output: string } | undefined;
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
      socketMode: true,
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
          // Slack's examples only: other channels have blocks of the same names ("direct messages").
          "test/acceptance/examples/slack.test.ts",
          "-t",
          `^(${EXAMPLES.join("|")})`,
        ],
        { cwd: ROOT, env: { ...env, NO_COLOR: "1" }, encoding: "utf8" },
      );
      run = { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
  );

  expect(run?.output).toContain("9 passed");
  expect(run?.output).not.toContain("failed");
  expect(run?.status).toBe(0);
}, 120_000);
