import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryPath } from "../../../scripts/lib/packages.ts";
import { eventually } from "../../../scripts/lib/process.ts";

/** The compiled binary under test: `CHANNELSTACK_SERVER_BIN`, or the one `pnpm build:binary` made for this machine. */
export const BINARY = process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();

export function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "channelstack-test-"));
}

/** Run the binary to completion. */
export function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  if (!existsSync(BINARY)) throw new Error(`No server binary at ${BINARY}. Run \`pnpm build\` first.`);
  const result = spawnSync(BINARY, args, { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface RunningBinary {
  home: string;
  /** The control API's base URL, from the server file. */
  url: string;
  token: string;
  child: ChildProcess;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  /** Call the control API. Pass `token: null` to send no Authorization header. */
  control(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
  stop(): Promise<number | null>;
}

/** Start the compiled binary with its own state directory and wait until it has written its server file. */
export async function startBinary(
  options: { args?: readonly string[]; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<RunningBinary> {
  if (!existsSync(BINARY)) throw new Error(`No server binary at ${BINARY}. Run \`pnpm build\` first.`);
  const home = options.home ?? temporaryHome();
  const child = spawn(BINARY, ["start", ...(options.args ?? ["--no-portless", "--port", "0"])], {
    env: { ...process.env, CHANNELSTACK_HOME: home, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const file = join(home, "server.json");
  const server = await eventually("the server file", () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The server exited with ${child.exitCode ?? child.signalCode}: ${output}`);
    }
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string }) : undefined;
  }).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw new Error(`${String(error)}\n${output}`);
  });

  return {
    home,
    ...server,
    child,
    output: () => output,
    async control(method, path, body, token = server.token) {
      const response = await fetch(`${server.url}/_channelstack${path}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
}
