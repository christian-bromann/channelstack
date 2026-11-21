import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { GITHUB_CHECKS, SLACK_CHECKS } from "../../integrations/checks/index.ts";
import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";

/** Per channel: the agent with one fault per check, where it takes webhooks, and the checks' ids. */
const CHANNELS = {
  slack: { agent: "broken-slack", path: "/slack/events", ids: SLACK_CHECKS },
  github: { agent: "broken-github", path: "/api/webhooks/github", ids: GITHUB_CHECKS },
} as const;

/** Run a channel's standard checks (all, or one) against its agent with one fault switched on (or none). */
async function checks(
  channel: keyof typeof CHANNELS,
  fault: string | undefined,
  only: string | undefined,
  agentEnv: Record<string, string> = {},
) {
  const { agent, path } = CHANNELS[channel];
  let run = { status: null as number | null, output: "" };
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", agent, "agent.ts"),
      webhook: { driver: channel, path },
      agentEnv: { ...agentEnv, ...(fault ? { BROKEN: fault } : {}) },
    },
    ({ env }) => {
      const file = `test/acceptance/checks/${channel}-checks.test.ts`;
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts", file],
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

// Exit checks 2.3 and 3.4: against a deliberately broken agent each check fails, one broken variant per check.
describe.for(Object.entries(CHANNELS))("the standard %s checks catch what they are for", ([name, { ids }]) => {
  const channel = name as keyof typeof CHANNELS;

  test("with no fault switched on, the agent passes every check", async () => {
    const run = await checks(channel, undefined, undefined);
    expect(run.output, run.output).toContain(`${ids.length} passed`);
    expect(run.status).toBe(0);
  }, 120_000);

  test.concurrent.for([...ids])("%s fails against the agent with that fault", { timeout: 120_000 }, async (id) => {
    const run = await checks(channel, id, id);
    expect(run.output, run.output).toContain("1 failed");
    expect(run.output).toContain(`[${id}]`);
    expect(run.status).toBe(1);
  });
});

test("an agent that takes the button away after the first click passes the double-click check", async () => {
  const run = await checks("slack", undefined, "slack.double-click", { REMOVES_BUTTON: "1" });
  expect(run.output, run.output).toContain("1 passed");
  expect(run.status).toBe(0);
}, 120_000);
