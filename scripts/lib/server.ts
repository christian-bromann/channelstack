import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../../sdks/typescript/runtime/wait.ts";

export interface StartedBinary {
  /** The server's state directory. */
  home: string;
  /** The control API's base URL and bearer token, from the server file. */
  url: string;
  token: string;
  child: ChildProcess;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  /** Stop the server and wait for it to be gone. Resolves with its exit code. */
  stop(): Promise<number | null>;
}

export interface StartBinaryOptions {
  /** The server executable. */
  bin: string;
  /** Arguments after `start`. Default: one free loopback port, no portless. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The state directory. Default: a fresh temporary one, so a run never touches `~/.channelstack`. */
  home?: string;
  /** The server file to wait for. Default: `<home>/server.json`. Pass the path given to `--server-file`. */
  serverFile?: string;
}

/**
 * Start a server executable and wait until it has written its server file. The one helper the
 * smoke runs and the integration tests share; the SDK launchers have their own, because they ship.
 */
export async function startBinary(options: StartBinaryOptions): Promise<StartedBinary> {
  if (!existsSync(options.bin)) throw new Error(`No server binary at ${options.bin}. Run \`pnpm build\` first.`);
  const home = options.home ?? mkdtempSync(join(tmpdir(), "channelstack-run-"));
  const file = options.serverFile ?? join(home, "server.json");
  // A file that is already there belongs to an earlier server: only a new one counts as this server's.
  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const before = read();
  const child = spawn(options.bin, ["start", ...(options.args ?? ["--no-portless", "--port", "0"])], {
    env: { ...process.env, CHANNELSTACK_HOME: home, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += String(chunk);
    });
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return exited;
  };

  try {
    const server = await waitFor(
      "the server to write its server file",
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`The server exited with ${child.exitCode ?? child.signalCode}`);
        }
        const written = read();
        if (written === undefined || written === before) return undefined;
        return JSON.parse(written) as { url: string; token: string };
      },
      { timeout: "30s" },
    );
    return { home, ...server, child, output: () => output, stop };
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}
