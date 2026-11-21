import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitFor } from "../../sdks/typescript/runtime/wait.ts";
import { background, capture, freePort } from "./process.ts";
import { startBinary } from "./server.ts";

export interface StackOptions {
  /** The server executable. */
  bin: string;
  /** The reference agent: a script `node` can run. It listens on `PORT`. */
  agent: string;
  /** Which driver delivers to the agent, and at which path of the agent. */
  webhook: { driver: string; path: string };
}

export interface RunningStack {
  /** The private state directory. With `CHANNELSTACK_HOME` set to it, SDKs attach to this server. */
  home: string;
  /** The environment for whatever runs against the stack: this process's, pointed at the stack. */
  env: NodeJS.ProcessEnv;
}

/**
 * Start the server next to a reference agent, the way a developer does it: the server knows the
 * agent's endpoint, and the agent gets its configuration from `channelstack env`. Runs `use`, then
 * stops both and removes the state directory.
 */
export async function withStack(
  options: StackOptions,
  use: (stack: RunningStack) => Promise<void> | void,
): Promise<void> {
  // A private state directory: a run never touches the developer's ~/.channelstack.
  const home = mkdtempSync(join(tmpdir(), "channelstack-stack-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CHANNELSTACK_HOME: home, CHANNELSTACK_LOG_LEVEL: "warn" };
  delete env.CHANNELSTACK_URL;
  delete env.CHANNELSTACK_TOKEN;
  const stops: Array<() => Promise<unknown>> = [];
  try {
    const port = await freePort();
    const webhookVariable = `CHANNELSTACK_${options.webhook.driver.toUpperCase()}_WEBHOOK_URL`;
    const server = await startBinary({
      bin: options.bin,
      home,
      env: { ...env, [webhookVariable]: `http://127.0.0.1:${port}${options.webhook.path}` },
    });
    stops.push(server.stop);

    const agentEnv = Object.fromEntries(
      capture(options.bin, ["env"], { env })
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const agent = background(process.execPath, [options.agent], { ...process.env, ...agentEnv, PORT: String(port) });
    stops.push(agent.stop);
    await waitFor("the reference agent to listen", () => {
      if (agent.child.exitCode !== null)
        throw new Error(`The agent ${options.agent} exited with ${agent.child.exitCode}`);
      return new Promise<true | undefined>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => resolve(socket.destroy() && true));
        socket.once("error", () => resolve(undefined));
      });
    });

    await use({ home, env });
  } finally {
    for (const stop of stops.reverse()) await stop();
    rmSync(home, { recursive: true, force: true });
  }
}
