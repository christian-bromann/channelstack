/**
 * A live server with every channel's reference agent, for whatever runs against the real
 * sandboxes: `pnpm live` (the examples' live blocks) and `pnpm conformance` (the differential run).
 *
 * Credentials come from the environment (CI's `live` environment, or `~/.channelstack/live.env`
 * sourced locally). channelstack never relays events live: each platform delivers to the agent
 * itself. Each channel's reference agent runs here (`live-agents.ts`): Slack's in Socket Mode,
 * the others behind the smee.io channel their platform's webhook points at.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PROXY_ENV_NAMES } from "../../server/src/app.ts";
import { createRecorder } from "../../server/src/core/proxy/record.ts";
import { runId } from "../../server/src/core/safety/index.ts";
import { startAgents, writeSessions } from "./live-agents.ts";
import { capture, run } from "./process.ts";
import { startBinary } from "./server.ts";

export interface LiveStack {
  /** The environment for what runs against it: attached to this server, with this run's id. */
  env: NodeJS.ProcessEnv;
  home: string;
  /** The server's own log (redacted by the server), for a failure's message. */
  serverLog(): string;
}

/**
 * Start the live server and the agents, run `use`, stop them, then check that the run left
 * nothing behind (exit check 5.2) and remove what it did. Answers whether everything passed:
 * `use` without throwing, and the sweep check.
 */
export async function withLiveStack(
  options: { bin: string; env: NodeJS.ProcessEnv; record?: string },
  use: (stack: LiveStack) => Promise<void>,
): Promise<boolean> {
  const { bin, env } = options;
  // One id for everything this run makes, so the sweep check can look for exactly that.
  const thisRun = runId(env);
  const home = mkdtempSync(join(tmpdir(), "channelstack-live-"));
  // The people's saved browser sessions (`channelstack login`), where this run's server looks for them.
  const saved = join(env.CHANNELSTACK_HOME || join(homedir(), ".channelstack"), "browser");
  if (existsSync(saved)) cpSync(saved, join(home, "browser"), { recursive: true });
  // In the nightly job they come from a secret instead, unless an earlier step left newer ones.
  writeSessions(env, home);
  const live: NodeJS.ProcessEnv = {
    ...env,
    CHANNELSTACK_HOME: home,
    CHANNELSTACK_RUN_ID: thisRun,
    CHANNELSTACK_LOG_LEVEL: "warn",
  };
  delete live.CHANNELSTACK_URL;
  delete live.CHANNELSTACK_TOKEN;

  const stops: Array<() => Promise<unknown>> = [];
  let serverLog = () => "";
  let ok = true;
  try {
    const record = options.record;
    const server = await startBinary({
      bin,
      home,
      env: live,
      ...(record ? { args: ["--no-portless", "--port", "0", "--proxy", "--proxy-port", "0", "--record", record] } : {}),
    });
    serverLog = server.output;
    stops.push(server.stop);
    if (record) {
      // The agents run behind the server's proxy, so the recorder sees their calls to the platforms,
      // and each relay is tapped for the platforms' real webhooks.
      const proxy = Object.fromEntries(
        capture(bin, ["env", "--proxy"], { env: live })
          .split("\n")
          .filter((line) => PROXY_ENV_NAMES.includes(line.slice(0, line.indexOf("="))))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      await startAgents(env, stops, { proxy, recorder: createRecorder(join(record, "relay")) });
    } else await startAgents(env, stops);
    await use({ env: live, home, serverLog: () => serverLog() });
  } catch (error) {
    ok = false;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`\nThe server's log:\n${serverLog()}\n`);
  } finally {
    // Stopping the server closes every session still open, and so removes what they made.
    for (const stop of stops.reverse()) await stop();
  }

  // Exit check 5.2: nothing this run made is left in any sandbox.
  try {
    run(bin, ["sweep", "--check", "--run", thisRun], { env: live });
  } catch {
    // A leftover is a bug in cleanup, and the run fails for it; but it doesn't stay in the sandbox.
    ok = false;
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
  return ok;
}
