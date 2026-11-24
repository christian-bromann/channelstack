/**
 * The live run (exit checks 5.1 and 5.2): every "live mode" block of the four example files
 * against the real sandboxes, then a sweep check that the run left nothing behind.
 *
 * Credentials come from the environment (CI's `live` environment, or `~/.channelstack/live.env`
 * sourced locally). channelstack never relays events live: each platform delivers to the agent
 * itself. Each channel's reference agent runs here (`lib/live-agents.ts`): Slack's in Socket Mode,
 * the others behind the smee.io channel their platform's webhook points at.
 *
 *   node scripts/live.ts [--bin <server>]
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runId } from "../server/src/core/safety/index.ts";
import { DRIVERS } from "../server/src/drivers/index.ts";
import { ROOT } from "./lib/generate.ts";
import { startAgents, writeSessions } from "./lib/live-agents.ts";
import { binaryPath } from "./lib/packages.ts";
import { run, runAsync } from "./lib/process.ts";
import { startBinary } from "./lib/server.ts";

const { values } = parseArgs({ options: { bin: { type: "string" } } });
const bin = values.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
const env = process.env;

// One id for everything this run makes, so the sweep check can look for exactly that.
const thisRun = runId(env);
const home = mkdtempSync(join(tmpdir(), "channelstack-live-"));
// The people's saved browser sessions (`channelstack login`), where this run's server looks for them.
const saved = join(env.CHANNELSTACK_HOME || join(homedir(), ".channelstack"), "browser");
if (existsSync(saved)) cpSync(saved, join(home, "browser"), { recursive: true });
// In the nightly job they come from a secret instead.
writeSessions(env, home);
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
/** The server's own log (redacted by the server), shown when the run fails. */
let serverLog = () => "";
let failed = false;
try {
  const server = await startBinary({ bin, home, env: live });
  serverLog = server.output;
  stops.push(server.stop);

  await startAgents(env, stops);

  try {
    // Not run: the relays in this process forward the platforms' webhooks to the agents meanwhile.
    await runAsync(
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
        // A real platform and a real agent take their time: the examples' own waits (60 s) decide, not Vitest's.
        "--testTimeout",
        "120000",
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
  // A channel whose credentials are set must have run live: a run that skipped all of it proves
  // nothing. That includes a channel whose live backend isn't built yet: exit check 5.1 isn't met
  // for it, and the job says so. Without a report (Vitest died), the run has failed already.
  let results: { testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }> } = {
    testResults: [],
  };
  try {
    results = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    failed = true;
    process.stderr.write("Vitest wrote no report: the live tests didn't run\n");
  }
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
  if (failed) process.stderr.write(`\nThe server's log:\n${serverLog()}\n`);
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
// The sessions as the run left them: a platform renews a session's cookies while it is used.
if (existsSync(join(home, "browser"))) cpSync(join(home, "browser"), saved, { recursive: true });
rmSync(home, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
