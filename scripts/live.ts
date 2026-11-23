/**
 * The live run (exit checks 5.1 and 5.2): every "live mode" block of the four example files
 * against the real sandboxes, then a sweep check that the run left nothing behind.
 *
 * Credentials come from the environment (CI's `live` environment, or `~/.channelstack/live.env`
 * sourced locally). channelstack never relays events live: each platform delivers to the agent
 * itself. Slack's reference agent runs here in Socket Mode, so it needs no public URL. GitHub,
 * Linear and Notion deliver over HTTP to agents deployed at their own public URLs; their live
 * blocks skip until those credentials exist.
 *
 *   node scripts/live.ts [--bin <server>]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runId } from "../server/src/core/safety/index.ts";
import { DRIVERS } from "../server/src/drivers/index.ts";
import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { run } from "./lib/process.ts";
import { startBinary } from "./lib/server.ts";

const { values } = parseArgs({ options: { bin: { type: "string" } } });
const bin = values.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
const env = process.env;

// One id for everything this run makes, so the sweep check can look for exactly that.
const thisRun = runId(env);
const home = mkdtempSync(join(tmpdir(), "channelstack-live-"));
const report = join(home, "vitest.json");
const live: NodeJS.ProcessEnv = {
  ...env,
  CHANNELSTACK_HOME: home,
  CHANNELSTACK_RUN_ID: thisRun,
  CHANNELSTACK_LOG_LEVEL: "warn",
};
delete live.CHANNELSTACK_URL;
delete live.CHANNELSTACK_TOKEN;

const stops: Array<() => Promise<unknown>> = [];
let failed = false;
try {
  const server = await startBinary({ bin, home, env: live });
  stops.push(server.stop);

  // Slack: the reference agent connects to real Slack itself, in Socket Mode.
  if (env.CHANNELSTACK_SLACK_BOT_TOKEN && env.CHANNELSTACK_SLACK_APP_TOKEN) {
    const agent = spawn(process.execPath, [join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts")], {
      env: {
        PATH: env.PATH,
        HOME: env.HOME,
        SLACK_BOT_TOKEN: env.CHANNELSTACK_SLACK_BOT_TOKEN,
        SLACK_APP_TOKEN: env.CHANNELSTACK_SLACK_APP_TOKEN,
        SLACK_SOCKET_MODE: "1",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<void>((resolve) => agent.once("exit", () => resolve()));
    stops.push(async () => {
      if (agent.exitCode === null) agent.kill("SIGTERM");
      await exited;
    });
    // The agent says when its socket to Slack is up.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The Slack agent didn't connect to Slack in 30s")), 30_000);
      agent.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Bolt app is running")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      agent.once("exit", (code) => reject(new Error(`The Slack agent exited with ${code}`)));
    });
  } else {
    process.stdout.write(
      "Slack: no CHANNELSTACK_SLACK_BOT_TOKEN and CHANNELSTACK_SLACK_APP_TOKEN; its live block skips\n",
    );
  }

  try {
    run(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/vitest.config.ts",
        ...["slack", "github", "linear", "notion"].map((channel) => `api/examples/${channel}.test.ts`),
        "-t",
        "live mode",
        "--reporter",
        "verbose",
        "--reporter",
        "json",
        "--outputFile.json",
        report,
      ],
      { cwd: ROOT, env: live },
    );
  } catch (error) {
    failed = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  // A channel whose credentials are set must have run live: a run that skipped all of it proves nothing.
  const results = JSON.parse(readFileSync(report, "utf8")) as {
    testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }>;
  };
  for (const driver of DRIVERS) {
    const credentials = driver.live?.credentials ?? [];
    if (credentials.length === 0 || credentials.some((name) => !env[name])) continue;
    const file = results.testResults.find((result) => result.name.endsWith(`api/examples/${driver.name}.test.ts`));
    if (!file?.assertionResults.some((test) => test.status === "passed")) {
      failed = true;
      process.stderr.write(
        `${driver.name}: its live credentials are set, and no live test of it passed (the reasons are above)\n`,
      );
    }
  }
} finally {
  // Stopping the server closes every session still open, and so removes what they made.
  for (const stop of stops.reverse()) await stop();
}

// Exit check 5.2: nothing this run made is left in any sandbox.
try {
  run(bin, ["sweep", "--check", "--run", thisRun], { env: live });
} catch {
  // A leftover is a bug in cleanup, and the run fails for it; but it doesn't stay in the sandbox.
  failed = true;
  process.stderr.write(`The sweep check found what run ${thisRun} left behind (above); removing it.\n`);
  try {
    run(bin, ["sweep", "--run", thisRun], { env: live });
  } catch {
    process.stderr.write(
      `Some of it couldn't be removed: \`channelstack sweep --run ${thisRun}\` with the same credentials retries.\n`,
    );
  }
}
rmSync(home, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
