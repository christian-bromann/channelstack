import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import * as checkIds from "../../integrations/checks/index.ts";
import { HARNESS, HARNESS_CHANNELS, PROVIDERS } from "../../scripts/lib/channels.ts";
import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";

/** Per channel: the agent with one fault per check, where it takes webhooks, and the checks' ids (`SLACK_CHECKS`). */
const CHANNELS = Object.fromEntries(
  HARNESS_CHANNELS.map((channel) => {
    const ids = (checkIds as unknown as Record<string, readonly string[] | undefined>)[
      `${channel.toUpperCase()}_CHECKS`
    ];
    if (!ids) throw new Error(`integrations/checks has no ${channel.toUpperCase()}_CHECKS`);
    return [channel, { ...HARNESS[channel].broken, ids }] as const;
  }),
);

/** Run a channel's standard checks (all, or one) against its agent with one fault switched on (or none). */
async function checks(
  channel: string,
  fault: string | undefined,
  only: string | undefined,
  agentEnv: Record<string, string> = {},
  suite: { agent: string; path: string; file: string; driver: string } = {
    ...(CHANNELS[channel] as { agent: string; path: string }),
    file: `test/acceptance/checks/${channel}-checks.test.ts`,
    driver: channel,
  },
) {
  const { agent, path } = suite;
  let run = { status: null as number | null, output: "" };
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", agent, "agent.ts"),
      webhook: { driver: suite.driver, path },
      agentEnv: { ...agentEnv, ...(fault ? { BROKEN: fault } : {}) },
    },
    ({ env }) => {
      const { file } = suite;
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

/** `CHANNELSTACK_BROKEN_CHANNELS=slack,github`: only these channels, so CI can run them side by side. */
const only = process.env.CHANNELSTACK_BROKEN_CHANNELS?.split(",").filter(Boolean);
const channels = Object.entries(CHANNELS).filter(([name]) => only === undefined || only.includes(name));

// Exit checks 2.3, 3.4 and 4.5: against a deliberately broken agent each check fails, one broken variant per check.
describe.for(channels)("the standard %s checks catch what they are for", ([name, { ids }]) => {
  const channel = name;

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

// Exit check 13.9: each model check fails against the agent on the fake OpenAI with that fault.
const providers = Object.entries(PROVIDERS).filter(([name]) => only === undefined || only.includes(name));
describe.for(providers)("the model checks of %s catch what they are for", ([name, { broken }]) => {
  const suite = { ...broken, file: `test/acceptance/checks/${name}-checks.test.ts`, driver: broken.channel };
  test.concurrent.for([...checkIds.SLACK_MODEL_CHECKS])(
    "%s fails against the agent with that fault",
    { timeout: 120_000 },
    async (id) => {
      const run = await checks(name, id, id, {}, suite);
      expect(run.output, run.output).toContain("1 failed");
      expect(run.output).toContain(`[${id}]`);
      expect(run.status).toBe(1);
    },
  );
});

test("an agent that takes the button away after the first click passes the double-click check", async () => {
  const run = await checks("slack", undefined, "slack.double-click", { REMOVES_BUTTON: "1" });
  expect(run.output, run.output).toContain("1 passed");
  expect(run.status).toBe(0);
}, 120_000);
