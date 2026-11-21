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

/** A loopback port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

/**
 * Poll until `probe` returns a value. For processes that take a moment to listen: a probe that
 * rejects (connection refused) counts as "not yet", a probe that throws synchronously ends the wait.
 */
export async function eventually<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve(probe()).catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
