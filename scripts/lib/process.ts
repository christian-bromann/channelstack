import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

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

/** Ports this process has handed out. The system may name the same free port twice before anything binds it. */
const handedOut = new Set<number>();

/**
 * A loopback port nothing is listening on right now, and that this process hasn't handed out
 * before: stacks that start side by side each get their own, though none has bound its port yet.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
        );
      });
    });
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
}
