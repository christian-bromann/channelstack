import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";
import { withStack } from "../../scripts/lib/stack.ts";

// Exit check 5.4: what live mode can't do skips the test with the reason, and doesn't fail it. The
// server gets GitHub App credentials (stand-ins: nothing is ever sent to GitHub), so GitHub is live,
// and live GitHub isn't built yet: every GitHub step is refused with unsupported_in_live. The same
// GitHub example then runs through the Vitest integration, unchanged, and must come back skipped.
test("a GitHub example on a live server is skipped with the reason", async () => {
  const server = await startBinary({
    bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
    env: {
      CHANNELSTACK_GITHUB_APP_ID: "1",
      CHANNELSTACK_GITHUB_PRIVATE_KEY: "a stand-in, never sent anywhere",
      CHANNELSTACK_LOG_LEVEL: "warn",
    },
  });
  try {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/vitest.config.ts",
        "api/examples/github.test.ts",
        "-t",
        "a mention in an issue gets one comment",
        "--reporter",
        "verbose",
      ],
      {
        cwd: ROOT,
        env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" },
        encoding: "utf8",
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(0);
    expect(output).not.toMatch(/\bfailed\b/);
    // Skipped once it started (the others are filtered out), with the reason in the report, where a
    // person reading the run sees it.
    expect(output).toMatch(
      /↓ .*a mention in an issue gets one comment.* \d+ms \[live: Session\.github isn't supported live: live github isn't built yet\]/,
    );
  } finally {
    await server.stop();
  }
}, 60_000);

// The other side of it: a setup that can't work fails the test instead. With only some of Slack's
// credentials set (here the app id, not the bot token), a Slack example must fail with
// live_misconfigured, so a nightly run with a typo in a variable name goes red.
test("a Slack example on a server with Slack's credentials set in part fails", async () => {
  const server = await startBinary({
    bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
    env: { CHANNELSTACK_SLACK_APP_ID: "A0000000001", CHANNELSTACK_LOG_LEVEL: "warn" },
  });
  try {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/vitest.config.ts",
        "api/examples/slack.test.ts",
        "-t",
        "a mention gets exactly one reply, in the thread",
        "--reporter",
        "verbose",
      ],
      {
        cwd: ROOT,
        env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" },
        encoding: "utf8",
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(1);
    expect(output).toMatch(/1 failed/);
    expect(output).toContain("slack has some of its live credentials and not all: set CHANNELSTACK_SLACK_BOT_TOKEN");
  } finally {
    await server.stop();
  }
}, 60_000);

// Every test has all four channels' fixtures. A channel refused live must not touch the others':
// with GitHub live and not built, a Slack example (fake, against its reference agent) still passes.
test("a channel refused live doesn't skip the tests of the others", async () => {
  let run: { status: number | null; output: string } | undefined;
  await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent: join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
      serverEnv: {
        CHANNELSTACK_GITHUB_APP_ID: "1",
        CHANNELSTACK_GITHUB_PRIVATE_KEY: "a stand-in, never sent anywhere",
      },
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
          "api/examples/slack.test.ts",
          "-t",
          "a mention gets exactly one reply, in the thread",
          "--reporter",
          "verbose",
        ],
        { cwd: ROOT, env: { ...env, NO_COLOR: "1" }, encoding: "utf8" },
      );
      run = { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
  );
  expect(run?.status, run?.output).toBe(0);
  expect(run?.output).toMatch(/✓ .*a mention gets exactly one reply, in the thread/);
}, 60_000);
