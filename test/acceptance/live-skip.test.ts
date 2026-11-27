import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";
import { withStack } from "../../scripts/lib/stack.ts";

// Exit check 5.4: what live mode can't do skips the test with the reason, and doesn't fail it. The
// server's GitHub is live against a stand-in for GitHub's API (nothing is sent to GitHub), with the
// App installed on all of the org's repositories, so a repository without it can't exist live. The
// GitHub example that needs one then runs through the Vitest integration, unchanged, and must come
// back skipped.
test("a GitHub example on a live server is skipped with the reason", async () => {
  const server = await startBinary({
    bin: join(ROOT, "test", "acceptance", "stand-ins", "github-live-server.sh"),
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
        "test/acceptance/vitest.config.ts",
        "test/acceptance/examples/github.test.ts",
        "-t",
        "no install, no events",
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
      /↓ .*no install, no events.* \d+ms \[live: GitHubFixture\.createRepo without apps isn't supported live: the App's installation covers all of acme-tests's repositories, so it hears about every one\]/,
    );
  } finally {
    await server.stop();
  }
}, 60_000);

// Issue #46: live, the platform delivers to the agent itself, so a delivery check has no delivery to
// redeliver or forge. It skips with that reason, before anything else: not failing with "caused no
// delivery", and not stepping over the delivery to skip later for another reason. Ana has a token
// the stand-in knows, so she acts in the live org and the checks get as far as their delivery.
test("the delivery checks on a live server skip with the delivery reason", async () => {
  const token = `ghp_${randomBytes(18).toString("hex")}`;
  const server = await startBinary({
    bin: join(ROOT, "test", "acceptance", "stand-ins", "github-live-server.sh"),
    env: { CHANNELSTACK_LOG_LEVEL: "warn", CHANNELSTACK_GITHUB_USER_ANA_TOKEN: token },
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
        "test/acceptance/checks/github-checks.test.ts",
        "-t",
        String.raw`\[github\.(redelivery|bad-signature)\]`,
        "--reporter",
        "verbose",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CHANNELSTACK_HOME: server.home,
          CHANNELSTACK_GITHUB_USER_ANA_TOKEN: token,
          NO_COLOR: "1",
        },
        encoding: "utf8",
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status, output).toBe(0);
    expect(output).not.toMatch(/\bfailed\b/);
    const reason = String.raw`\[live: GitHub delivers to the agent itself, so delivery checks are fake-only\]`;
    for (const id of ["redelivery", "bad-signature"]) {
      expect(output).toMatch(new RegExp(String.raw`↓ .*\[github\.${id}\].* \d+ms ${reason}`));
    }
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
        "test/acceptance/examples/slack.test.ts",
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
// with GitHub live and its App's key a stand-in that signs nothing, a Slack example (fake, against
// its reference agent) still passes.
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
          "test/acceptance/examples/slack.test.ts",
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
