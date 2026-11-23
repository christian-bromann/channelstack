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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { waitFor } from "../sdks/typescript/runtime/wait.ts";
import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { background, run } from "./lib/process.ts";
import { startBinary } from "./lib/server.ts";

const { values } = parseArgs({ options: { bin: { type: "string" } } });
const bin = values.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
const env = process.env;

// One id for everything this run makes, so the sweep check can look for exactly that.
const runId = (env.CHANNELSTACK_RUN_ID ?? `l${Date.now().toString(36)}`).toLowerCase();
const home = mkdtempSync(join(tmpdir(), "channelstack-live-"));
const live = { ...env, CHANNELSTACK_HOME: home, CHANNELSTACK_RUN_ID: runId, CHANNELSTACK_LOG_LEVEL: "warn" };
delete live.CHANNELSTACK_URL;
delete live.CHANNELSTACK_TOKEN;

const stops: Array<() => Promise<unknown>> = [];
let failed = false;
try {
  const server = await startBinary({ bin, home, env: live });
  stops.push(server.stop);

  // Slack: the reference agent connects to real Slack itself, in Socket Mode.
  if (env.CHANNELSTACK_SLACK_BOT_TOKEN && env.CHANNELSTACK_SLACK_APP_TOKEN) {
    const agent = background(process.execPath, [join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts")], {
      PATH: env.PATH,
      HOME: env.HOME,
      SLACK_BOT_TOKEN: env.CHANNELSTACK_SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: env.CHANNELSTACK_SLACK_APP_TOKEN,
      SLACK_SOCKET_MODE: "1",
    });
    stops.push(agent.stop);
    // Bolt reports nothing when its socket is up; give it the time a connection takes, and fail if it died.
    await waitFor(
      "the Slack agent to connect to Slack",
      async () => {
        if (agent.child.exitCode !== null) throw new Error(`The Slack agent exited with ${agent.child.exitCode}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return true;
      },
      { timeout: "30s" },
    );
  } else {
    process.stdout.write("Slack: no CHANNELSTACK_SLACK_BOT_TOKEN and CHANNELSTACK_SLACK_APP_TOKEN; its live block skips\n");
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
      ],
      { cwd: ROOT, env: live },
    );
  } catch (error) {
    failed = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
} finally {
  // Stopping the server closes every session still open, and so removes what they made.
  for (const stop of stops.reverse()) await stop();
}

// Exit check 5.2: nothing this run made is left in any sandbox.
try {
  run(bin, ["sweep", "--check", "--run", runId], { env: live });
} catch {
  failed = true;
  process.stderr.write(`The sweep check found what run ${runId} left behind (above). \`channelstack sweep --run ${runId}\` removes it.\n`);
}
rmSync(home, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
