import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processRunning } from "../../server/src/core/home/index.ts";

/** Run a command to completion, with its output on this terminal. Throws when it fails. */
export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

/**
 * Run a command to completion without blocking this process: what this process does meanwhile
 * (a relay forwarding webhooks to an agent) keeps running. Throws when it fails.
 */
export async function runAsync(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const code = await new Promise<number | string | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(status ?? signal));
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}`);
}

/** Run a command and return what it printed. Throws when it fails. */
export function capture(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

/** Start a long-running process. `stop` ends it and waits for it to be gone. */
export function background(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; stop(): Promise<void> } {
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "inherit"] });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

/**
 * Where the processes of a run note the ports they hand out. Vitest runs each test file in its own
 * worker: two stacks started side by side in two workers must not get the same port, or the second
 * agent can't listen, and its test talks to the first one's agent.
 */
const CLAIMS = join(tmpdir(), `channelstack-ports-${process.getuid?.() ?? "user"}`);
/**
 * How long a claim holds at most: long enough for a stack to start its server and then its agent
 * on the port. By then the agent listens on it, and the probe turns the port down anyway.
 */
const CLAIM_MS = 5 * 60_000;
/**
 * Ports come from below every system's ephemeral range (Linux's starts at 32768, macOS's and
 * Windows' at 49152): nothing that binds port 0, such as a server started with `--port 0`, is given
 * one of them between `freePort` and the agent's own `listen`.
 */
const RANGE = { from: 20_000, to: 32_767 } as const;

/** This process's claims, by port. */
const mine = new Map<number, string>();
let swept = false;

/**
 * Has a claim (`<port>-<pid>-<uuid>`) lapsed? It has once it is older than `CLAIM_MS` or its
 * process is gone: Vitest ends its workers without an `exit` event, so not every process can give
 * its claims up itself. A claim that was removed meanwhile has lapsed too.
 */
const lapsed = (name: string, now: number) => {
  if (!processRunning(Number(name.split("-")[1]))) return true;
  try {
    return now - statSync(join(CLAIMS, name)).mtimeMs >= CLAIM_MS;
  } catch {
    return true;
  }
};

/**
 * Claim a port for this process, unless another one holds a claim on it that hasn't lapsed. The
 * claim is written first and the others read second: of two processes claiming the same port at
 * once, at least one sees the other and gives way, so both never win.
 */
function claim(port: number): boolean {
  mkdirSync(CLAIMS, { recursive: true, mode: 0o700 });
  const now = Date.now();
  // Once per process: give this process's claims up when it exits (when it gets the chance), and
  // remove the claims that have lapsed, so they don't pile up.
  if (!swept) {
    swept = true;
    process.once("exit", () => {
      for (const name of mine.values()) rmSync(join(CLAIMS, name), { force: true });
    });
    for (const name of readdirSync(CLAIMS)) if (lapsed(name, now)) rmSync(join(CLAIMS, name), { force: true });
  }
  const own = `${port}-${process.pid}-${randomUUID()}`;
  writeFileSync(join(CLAIMS, own), "", { flag: "wx" });
  const taken = readdirSync(CLAIMS).some((name) => name.startsWith(`${port}-`) && name !== own && !lapsed(name, now));
  if (taken) {
    rmSync(join(CLAIMS, own), { force: true });
    return false;
  }
  mine.set(port, own);
  return true;
}

/** Give a claim up: the port turned out to be in use. */
function release(port: number): void {
  const name = mine.get(port);
  if (name === undefined) return;
  mine.delete(port);
  rmSync(join(CLAIMS, name), { force: true });
}

/**
 * Can a server listen on this port on every interface? The probe names no host, so Node binds `::`
 * (IPv4 included), or `0.0.0.0` where IPv6 is off. Some agents listen that way (Bolt's
 * `app.start(port)`, Go's `ListenAndServe(":port")`), and a port free on loopback alone can still
 * be taken there (EADDRINUSE). A port free on every interface suits them and the agents that bind
 * `127.0.0.1`.
 */
const bindable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });

/**
 * A port nothing is listening on right now, and that no running process has handed out in the last
 * `CLAIM_MS`: stacks that start side by side, in one process or several, each get their own,
 * though none has bound its port yet.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = randomInt(RANGE.from, RANGE.to + 1);
    if (!claim(port)) continue;
    if (await bindable(port)) return port;
    release(port);
  }
}
