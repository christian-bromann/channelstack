import { join } from "node:path";

import { type App, type AppOptions, CONTROL_PREFIX, createApp, type LiveOptions, type ServerUrls } from "./app.ts";
import { createBearerToken } from "./core/auth/index.ts";
import { loadCa } from "./core/ca/index.ts";
import { readPrivateJsonFile, removeFile, writePrivateFile } from "./core/home/index.ts";
import { ledgerDir } from "./core/ledger/index.ts";
import { createLogger, type LogLevel } from "./core/log/index.ts";
import { registerAliases } from "./core/portless/index.ts";
import { type RunningProxy, startProxy } from "./core/proxy/index.ts";
import { writeNodePreload } from "./core/proxy/node.ts";
import { Redactor } from "./core/redact/index.ts";
import type { SocketSession } from "./core/router/index.ts";
import { Secrets } from "./core/secrets/index.ts";
import { DRIVERS, proxyHosts, secretSpecs } from "./drivers/index.ts";

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
  /**
   * Proxy mode (implementation plan 6.2): also listen on this loopback port as an HTTP proxy that
   * routes the provider hosts to the fakes. 0 picks a free one. Without it, no proxy.
   */
  proxyPort?: number;
  /**
   * For tests that start a whole server: stand-ins for the platforms live mode calls. Only code
   * can pass it, never a flag or the environment, so a token can't be sent elsewhere.
   */
  platforms?: Pick<LiveOptions, "fetch" | "apiBase">;
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
  /** Proxy mode: the proxy's URL. */
  proxy?: string;
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
    live: {
      env: options.env ?? {},
      ledgerFile: join(ledgerDir(options.home), `${process.pid}-${Date.now()}.json`),
      home: options.home,
      ...options.platforms,
    },
    urls: () => {
      if (!urls) throw new Error("The server isn't listening yet");
      return urls;
    },
  });

  // The same answers on every listener: the loopback port, and in proxy mode the TLS one behind the proxy.
  const handler = {
    fetch(request: Request, listening: Bun.Server<{ session: SocketSession }>) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return app.fetch(request);
      // A WebSocket is only opened where a fake expects one (Slack's Socket Mode, with its ticket).
      const session = app.socket(request);
      if (session && listening.upgrade(request, { data: { session } })) return undefined;
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open: (socket: Bun.ServerWebSocket<{ session: SocketSession }>) =>
        socket.data.session.open({ send: (text) => void socket.send(text), close: () => socket.terminate() }),
      message: (socket: Bun.ServerWebSocket<{ session: SocketSession }>, message: string | Buffer) =>
        socket.data.session.message(String(message)),
      close: (socket: Bun.ServerWebSocket<{ session: SocketSession }>) => socket.data.session.closed(),
    },
  };
  const server = Bun.serve<{ session: SocketSession }>({ hostname: LOOPBACK, port: options.port, ...handler });
  const origin = `http://${LOOPBACK}:${server.port}`;

  let proxy: RunningProxy | undefined;
  let proxyServer: Bun.Server<{ session: SocketSession }> | undefined;
  let removeAliases = async () => {};
  try {
    let proxied: ServerUrls["proxy"];
    if (options.proxyPort !== undefined) {
      // Proxy mode: the provider hosts, served over TLS by a certificate from channelstack's own CA.
      const hosts = proxyHosts();
      const ca = await loadCa(options.home, hosts);
      const leaf = await ca.issue(hosts);
      const tls = Bun.serve<{ session: SocketSession }>({
        hostname: LOOPBACK,
        port: 0,
        tls: { cert: leaf.cert, key: leaf.key },
        ...handler,
      });
      proxyServer = tls;
      proxy = await startProxy({
        port: options.proxyPort,
        log,
        route: (host) => (hosts.includes(host) ? { host: LOOPBACK, port: Number(tls.port) } : undefined),
      });
      proxied = {
        url: proxy.url,
        caFile: ca.caFile,
        bundleFile: ca.bundleFile,
        nodePreload: writeNodePreload(options.home),
      };
    }
    // In proxy mode a fake's own URLs are the provider's (`wss://slack.com/link`), so an agent that
    // reaches the platforms only through the proxy reaches them too.
    const providerOrigin = (name: string) => {
      const host = proxied ? DRIVERS.find((driver) => driver.name === name)?.hosts?.[0] : undefined;
      return host ? `https://${host}` : undefined;
    };
    const listening: ServerUrls = options.portless
      ? {
          control: "https://channelstack.localhost",
          driver: (name) => providerOrigin(name) ?? `https://${name}.localhost`,
        }
      : { control: origin, driver: (name) => providerOrigin(name) ?? `${origin}/${name}` };
    if (proxied) listening.proxy = proxied;
    urls = listening;

    if (options.portless) removeAliases = await registerAliases(app.hosts(), Number(server.port));
    const file: ServerFile = {
      url: listening.control,
      token,
      pid: process.pid,
      version: options.version,
      local: origin,
      ...(proxy ? { proxy: proxy.url } : {}),
    };
    writePrivateFile(serverFile, `${JSON.stringify(file, null, 2)}\n`);
  } catch (error) {
    // Nothing may be left behind by a start that failed: no names pointing at a dead port, no listener.
    await removeAliases();
    await proxy?.stop();
    await proxyServer?.stop(true);
    await server.stop(true);
    throw error;
  }
  const listening = urls;
  log.info("listening", {
    address: `${LOOPBACK}:${server.port}`,
    control: `${listening.control}${CONTROL_PREFIX}`,
    portless: options.portless,
    ...(proxy ? { proxy: proxy.url } : {}),
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
      await proxy?.stop();
      await proxyServer?.stop(true);
      await server.stop(true);
    },
  };
}
