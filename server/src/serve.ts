import { join } from "node:path";

import { type App, type AppOptions, CONTROL_PREFIX, createApp, type ServerUrls } from "./app.ts";
import { createBearerToken } from "./core/auth/index.ts";
import { readPrivateJsonFile, removeFile, writePrivateFile } from "./core/home/index.ts";
import { ledgerDir } from "./core/ledger/index.ts";
import { createLogger, type LogLevel } from "./core/log/index.ts";
import { registerAliases } from "./core/portless/index.ts";
import { Redactor } from "./core/redact/index.ts";
import type { SocketSession } from "./core/router/index.ts";
import { Secrets } from "./core/secrets/index.ts";
import { secretSpecs } from "./drivers/index.ts";

/** The only address the server binds: the control API is never reachable from another machine. */
const LOOPBACK = "127.0.0.1";

export interface StartOptions {
  version: string;
  /** The state directory (`CHANNELSTACK_HOME`, or `~/.channelstack`). */
  home: string;
  /** Serve through portless as `*.localhost`. Without it, one port with path prefixes. */
  portless: boolean;
  /** The loopback port. 0 picks a free one. */
  port: number;
  /** Where to write `{ url, token }` for clients. Defaults to `<home>/server.json`. */
  serverFile: string | undefined;
  seed: number;
  logLevel: LogLevel;
  webhooks: AppOptions["webhooks"];
  /** The UI page (see `AppOptions.ui`). Without it the server has no UI. */
  ui?: string;
  /** The environment live mode reads: credentials, allowlists, `CHANNELSTACK_REALITY`, `CHANNELSTACK_RUN_ID`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RunningServer {
  urls: ServerUrls;
  app: App;
  stop(): Promise<void>;
}

export function serverFilePath(home: string): string {
  return join(home, "server.json");
}

interface ServerFile {
  /** Where clients reach the server: the portless name, or the loopback origin. */
  url: string;
  token: string;
  pid: number;
  version: string;
  /** The loopback origin the server listens on, whatever `url` is. */
  local: string;
}

/** The server file's contents, if it is there and readable as one. */
function readServerFile(path: string): Partial<ServerFile> | undefined {
  try {
    const contents = readPrivateJsonFile(path);
    return typeof contents === "object" && contents !== null ? contents : undefined;
  } catch {
    // A file that isn't JSON describes no server.
    return undefined;
  }
}

/**
 * Is the server a server file describes still there? Only an answer counts: a pid alone proves
 * nothing, because after a crash or a reboot it may belong to any other process.
 */
async function answers(file: Partial<ServerFile>): Promise<boolean> {
  const origin = file.local ?? file.url;
  if (typeof origin !== "string" || typeof file.token !== "string") return false;
  try {
    const response = await fetch(`${origin}${CONTROL_PREFIX}/status`, {
      headers: { authorization: `Bearer ${file.token}` },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the server: load the install's secrets, bind loopback, register portless names, and write the token file. */
export async function start(options: StartOptions): Promise<RunningServer> {
  const serverFile = options.serverFile ?? serverFilePath(options.home);
  // A server file belongs to one server. Taking it over would cut the running server off from
  // the CLI and every SDK that attached to it (decision 0004).
  const existing = readServerFile(serverFile);
  if (existing && (await answers(existing))) {
    throw new Error(
      `A channelstack server is already running at ${existing.url} (pid ${existing.pid}, from ${serverFile}). ` +
        "Stop it first, or start a private one with --server-file <path>.",
    );
  }
  const secrets = Secrets.load(options.home, secretSpecs());
  const token = createBearerToken();
  const redactor = new Redactor();
  redactor.register(token, ...secrets.all());
  const log = createLogger({ level: options.logLevel, redactor, write: (line) => process.stderr.write(`${line}\n`) });

  let urls: ServerUrls | undefined;
  const app = createApp({
    version: options.version,
    token,
    seed: options.seed,
    secrets,
    redactor,
    log,
    webhooks: options.webhooks,
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    // One ledger file per server, so a crash leaves what this one created for `channelstack sweep`.
    live: { env: options.env ?? {}, ledgerFile: join(ledgerDir(options.home), `${process.pid}-${Date.now()}.json`) },
    urls: () => {
      if (!urls) throw new Error("The server isn't listening yet");
      return urls;
    },
  });

  const server = Bun.serve<{ session: SocketSession }>({
    hostname: LOOPBACK,
    port: options.port,
    fetch(request, listening) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return app.fetch(request);
      // A WebSocket is only opened where a fake expects one (Slack's Socket Mode, with its ticket).
      const session = app.socket(request);
      if (session && listening.upgrade(request, { data: { session } })) return undefined;
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open: (socket) =>
        socket.data.session.open({ send: (text) => void socket.send(text), close: () => socket.terminate() }),
      message: (socket, message) => socket.data.session.message(String(message)),
      close: (socket) => socket.data.session.closed(),
    },
  });
  const origin = `http://${LOOPBACK}:${server.port}`;
  const listening: ServerUrls = options.portless
    ? { control: "https://channelstack.localhost", driver: (name) => `https://${name}.localhost` }
    : { control: origin, driver: (name) => `${origin}/${name}` };
  urls = listening;

  let removeAliases = async () => {};
  try {
    if (options.portless) removeAliases = await registerAliases(app.hosts(), Number(server.port));
    const file: ServerFile = {
      url: listening.control,
      token,
      pid: process.pid,
      version: options.version,
      local: origin,
    };
    writePrivateFile(serverFile, `${JSON.stringify(file, null, 2)}\n`);
  } catch (error) {
    // Nothing may be left behind by a start that failed: no names pointing at a dead port, no listener.
    await removeAliases();
    await server.stop(true);
    throw error;
  }
  log.info("listening", {
    address: `${LOOPBACK}:${server.port}`,
    control: `${listening.control}${CONTROL_PREFIX}`,
    portless: options.portless,
  });

  return {
    urls: listening,
    app,
    async stop() {
      // Live sessions still open remove what they created on the real platforms first.
      await app.close();
      // Only this server's own file: after a crash and restart it may already describe another one.
      if (readServerFile(serverFile)?.token === token) removeFile(serverFile);
      await removeAliases();
      await server.stop(true);
    },
  };
}
