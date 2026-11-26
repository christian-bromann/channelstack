import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitFor } from "../../sdks/typescript/runtime/wait.ts";
import { background, capture, freePort } from "./process.ts";
import { startBinary } from "./server.ts";

/** How long an agent may take to come up. Several stacks start side by side in CI, on few cores. */
const STARTUP = { timeout: "45s" } as const;

export interface StackOptions {
  /** The server executable. */
  bin: string;
  /** The reference agent: a script `node` can run. It listens on `PORT`. */
  agent: string;
  /** Which driver delivers to the agent, and at which path of the agent. */
  webhook: { driver: string; path: string };
  /**
   * Start the agent in Slack's Socket Mode (`SLACK_SOCKET_MODE=1`): it connects out to the fake,
   * and the server is given no endpoint to deliver to.
   */
  socketMode?: boolean;
  /**
   * Proxy mode (exit check 6.1): the server runs its proxy, and the agent gets what
   * `channelstack env --proxy` prints, with no API URL, so it calls the platforms' own hosts.
   */
  proxy?: boolean;
  /** With `proxy`: the recorder's directory (`--record`), for the shape differ. */
  record?: string;
  /** Extra environment for the agent, on top of what `channelstack env` prints. */
  agentEnv?: Readonly<Record<string, string>>;
  /** Extra environment for the server only: live credentials, for a test of what live does to a run. */
  serverEnv?: Readonly<Record<string, string>>;
  /** More agents next to it, one per channel, all against the same server (every channel in one run). */
  others?: ReadonlyArray<{ agent: string; webhook: { driver: string; path: string } }>;
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
    const others = await Promise.all(
      (options.others ?? []).map(async (other) => ({ ...other, port: await freePort() })),
    );
    const webhookUrl = (webhook: { driver: string; path: string }, at: number) => ({
      [`CHANNELSTACK_${webhook.driver.toUpperCase()}_WEBHOOK_URL`]: `http://127.0.0.1:${at}${webhook.path}`,
    });
    const server = await startBinary({
      bin: options.bin,
      home,
      ...(options.proxy
        ? {
            args: [
              ...["--no-portless", "--port", "0", "--proxy", "--proxy-port", "0"],
              ...(options.record ? ["--record", options.record] : []),
            ],
          }
        : {}),
      env: {
        ...env,
        ...(options.socketMode ? {} : webhookUrl(options.webhook, port)),
        ...Object.assign({}, ...others.map((other) => webhookUrl(other.webhook, other.port))),
        ...options.serverEnv,
      },
    });
    stops.push(server.stop);

    const agentEnv = Object.fromEntries(
      capture(options.bin, options.proxy ? ["env", "--proxy"] : ["env"], { env })
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const agent = background(process.execPath, [options.agent], {
      ...process.env,
      ...agentEnv,
      PORT: String(port),
      ...(options.socketMode ? { SLACK_SOCKET_MODE: "1" } : {}),
      ...options.agentEnv,
    });
    stops.push(agent.stop);
    const companions = others.map((other) => {
      const started = background(process.execPath, [other.agent], {
        ...process.env,
        ...agentEnv,
        PORT: String(other.port),
      });
      stops.push(started.stop);
      return { ...other, started };
    });
    /** Which agent has exited, in a sentence, or undefined while they all run. */
    const exited = () => {
      for (const { path, child } of [
        { path: options.agent, child: agent.child },
        ...companions.map((other) => ({ path: other.agent, child: other.started.child })),
      ])
        if (child.exitCode !== null) return `The agent ${path} exited with ${child.exitCode}`;
      return undefined;
    };
    const running = () => {
      const why = exited();
      if (why) throw new Error(why);
    };
    /** Something answers on this port. */
    const listening = (at: number) =>
      new Promise<true | undefined>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: at });
        socket.once("connect", () => resolve(socket.destroy() && true));
        socket.once("error", () => resolve(undefined));
      });
    if (options.socketMode) {
      // In Socket Mode the agent listens nowhere: it is ready once the fake sees its connection.
      const { url, token } = server;
      const control = (method: string, path: string) =>
        fetch(`${url}/_channelstack${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      const { sessionId } = (await (await control("POST", "/sessions")).json()) as { sessionId: string };
      await waitFor(
        "the reference agent to connect",
        async () => {
          running();
          const fixture = (await (await control("GET", `/sessions/${sessionId}/slack`)).json()) as {
            socketConnections: number;
          };
          return fixture.socketConnections > 0 ? true : undefined;
        },
        STARTUP,
      );
      await control("DELETE", `/sessions/${sessionId}`);
    } else
      await waitFor(
        "the reference agent to listen",
        () => {
          running();
          return listening(port);
        },
        STARTUP,
      );
    for (const other of companions)
      await waitFor(
        `the reference agent ${other.agent} to listen`,
        () => {
          running();
          return listening(other.port);
        },
        STARTUP,
      );

    // Something answers on the port, and `freePort` gave it to no other stack: make sure this agent
    // didn't fail to listen all the same.
    running();
    try {
      await use({ home, env });
    } catch (error) {
      // An agent that died during the test is why it failed, not what the test was waiting for.
      const why = exited();
      throw why ? new Error(`${why} during the test`, { cause: error }) : error;
    }
  } finally {
    for (const stop of stops.reverse()) await stop();
    rmSync(home, { recursive: true, force: true });
  }
}
