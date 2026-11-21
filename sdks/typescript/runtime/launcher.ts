import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./wait.ts";

export interface LaunchOptions {
  /**
   * `auto` (default): attach if a server is running, otherwise start one for the run.
   * `attach`: fail if none is running. `start`: always start a private one.
   */
  mode?: "auto" | "attach" | "start";
  /** Attach to this server instead of the one in `server.json`. Also `CHANNELSTACK_URL`, with `CHANNELSTACK_TOKEN`. */
  server?: string;
}

/** A server to talk to. `stop` only stops a server this launcher started. */
export interface ServerConnection {
  url: string;
  token: string;
  stop(): Promise<void>;
}

interface ServerFile {
  url: string;
  token: string;
}

const STATUS_PATH = "/_channelstack/status";

function readServerFile(path: string): ServerFile | undefined {
  try {
    const { url, token } = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerFile>;
    return typeof url === "string" && typeof token === "string" ? { url, token } : undefined;
  } catch {
    return undefined;
  }
}

async function isUp({ url, token }: ServerFile): Promise<boolean> {
  try {
    const response = await fetch(new URL(STATUS_PATH, url), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The running server a client should attach to, if there is one: an explicit URL, or the one in `server.json`. */
function attachTarget(options: LaunchOptions, env: NodeJS.ProcessEnv): ServerFile | undefined {
  const url = options.server ?? env.CHANNELSTACK_URL;
  const home = env.CHANNELSTACK_HOME || join(homedir(), ".channelstack");
  const file = readServerFile(join(home, "server.json"));
  if (url === undefined) return file;
  const token = env.CHANNELSTACK_TOKEN ?? (file?.url === url ? file.token : undefined);
  return token === undefined ? undefined : { url, token };
}

/** The npm package that carries the server binary for this machine. */
export function serverPackageName(platform: string = process.platform, arch: string = process.arch): string {
  return `@channelstack/server-${platform}-${arch}`;
}

export function serverBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "channelstack.exe" : "channelstack";
}

/** The server binary: `CHANNELSTACK_SERVER_BIN`, or the one installed with the `channelstack` package. */
export function resolveServerBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHANNELSTACK_SERVER_BIN) return env.CHANNELSTACK_SERVER_BIN;
  const name = serverPackageName();
  try {
    return createRequire(import.meta.url).resolve(`${name}/bin/${serverBinaryName()}`);
  } catch {
    throw new Error(
      `channelstack has no server binary for ${process.platform}-${process.arch}: the optional dependency ${name} isn't installed. ` +
        "Reinstall without --no-optional, or set CHANNELSTACK_SERVER_BIN.",
    );
  }
}

/** Start a private server on a free loopback port. Its token goes to a private file, never to the shared `server.json`. */
async function startServer(env: NodeJS.ProcessEnv): Promise<ServerConnection> {
  const directory = mkdtempSync(join(tmpdir(), "channelstack-"));
  const serverFile = join(directory, "server.json");
  const child: ChildProcess = spawn(
    resolveServerBinary(env),
    ["start", "--no-portless", "--port", "0", "--server-file", serverFile],
    { env, stdio: ["ignore", "ignore", "inherit"] },
  );
  // Set once the process is gone: how it ended, in words for the error message.
  let ended: string | undefined;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      ended = `exited with ${code ?? signal}`;
      resolve();
    });
    child.once("error", (error) => {
      ended = `could not be started: ${error.message}`;
      resolve();
    });
  });
  const stop = async () => {
    if (ended === undefined) child.kill("SIGTERM");
    await exit;
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const server = await waitFor(
      "the channelstack server to start",
      async () => {
        if (ended !== undefined) throw new Error(`The channelstack server ${ended} before it was ready`);
        const file = readServerFile(serverFile);
        return file && (await isUp(file)) ? file : undefined;
      },
      { timeout: "15s" },
    );
    return { ...server, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Find or start the server, by `mode`. */
export async function launch(
  options: LaunchOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerConnection> {
  const mode = options.mode ?? "auto";
  if (mode !== "start") {
    const target = attachTarget(options, env);
    if (target && (await isUp(target))) return { ...target, stop: async () => {} };
    if (mode === "attach") {
      throw new Error(
        target
          ? `No channelstack server is answering at ${target.url}. Start one with \`npx channelstack\`.`
          : "No running channelstack server found. Start one with `npx channelstack`, or set CHANNELSTACK_URL and CHANNELSTACK_TOKEN.",
      );
    }
  }
  return startServer(env);
}
