import { spawn } from "node:child_process";

type Run = (args: readonly string[]) => Promise<void>;

/** Runs the user's installed `portless` CLI. Arguments are passed as an array, never through a shell. */
const runPortless: Run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("portless", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("portless isn't installed. Install it (npm install -g portless) or start with --no-portless.")
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`portless ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
    });
  });

/**
 * Register `<name>.localhost` for each name, all pointing at the server's port.
 * Returns the function that removes them again on stop.
 */
export async function registerAliases(
  names: readonly string[],
  port: number,
  run: Run = runPortless,
): Promise<() => Promise<void>> {
  const registered: string[] = [];
  const remove = async () => {
    for (const name of registered.splice(0)) await run(["alias", "--remove", name]).catch(() => undefined);
  };
  try {
    for (const name of names) {
      await run(["alias", name, String(port)]);
      registered.push(name);
    }
  } catch (error) {
    await remove();
    throw error;
  }
  return remove;
}
