import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SLACK_CHECKS } from "../../integrations/checks/index.ts";
import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";

/** Run the standard checks (all, or one) against the agent with one fault switched on (or none). */
async function checks(fault: string | undefined, only: string | undefined, agentEnv: Record<string, string> = {}) {
  let run = { status: null as number | null, output: "" };
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", "broken-slack", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
      agentEnv: { ...agentEnv, ...(fault ? { BROKEN: fault } : {}) },
    },
    ({ env }) => {
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts", "test/acceptance/checks"],
        {
          cwd: ROOT,
          env: { ...env, NO_COLOR: "1", ...(only ? { CHANNELSTACK_CHECKS_ONLY: only } : {}) },
          encoding: "utf8",
        },
      );
      run = { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
  );
  return run;
}

// Exit check 2.3: against a deliberately broken agent each check fails, one broken variant per check.
describe("the standard Slack checks catch what they are for", () => {
  test("with no fault switched on, the agent passes every check", async () => {
    const run = await checks(undefined, undefined);
    expect(run.output).toContain(`${SLACK_CHECKS.length} passed`);
    expect(run.status).toBe(0);
  }, 120_000);

  test("an agent that takes the button away after the first click passes the double-click check", async () => {
    const run = await checks(undefined, "slack.double-click", { REMOVES_BUTTON: "1" });
    expect(run.output, run.output).toContain("1 passed");
    expect(run.status).toBe(0);
  }, 120_000);

  test.concurrent.for([...SLACK_CHECKS])(
    "%s fails against the agent with that fault",
    { timeout: 120_000 },
    async (id) => {
      const run = await checks(id, id);
      expect(run.output, run.output).toContain("1 failed");
      expect(run.output).toContain(`[${id}]`);
      expect(run.status).toBe(1);
    },
  );
});
