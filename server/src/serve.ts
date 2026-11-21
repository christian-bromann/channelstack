import { join } from "node:path";
import { type App, type AppOptions, CONTROL_PREFIX, createApp, type ServerUrls } from "./app.ts";
import { createBearerToken } from "./core/auth/index.ts";
import { removeFile, writePrivateFile } from "./core/home/index.ts";
import { createLogger, type LogLevel } from "./core/log/index.ts";
import { registerAliases } from "./core/portless/index.ts";
import { Redactor } from "./core/redact/index.ts";
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
}

export interface RunningServer {
  urls: ServerUrls;
  app: App;
  stop(): Promise<void>;
}

export function serverFilePath(home: string): string {
  return join(home, "server.json");
}

/** Start the server: load the install's secrets, bind loopback, register portless names, and write the token file. */
export async function start(options: StartOptions): Promise<RunningServer> {
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
    urls: () => {
      if (!urls) throw new Error("The server isn't listening yet");
      return urls;
    },
  });

  const server = Bun.serve({ hostname: LOOPBACK, port: options.port, fetch: (request) => app.fetch(request) });
  const origin = `http://${LOOPBACK}:${server.port}`;
  const listening: ServerUrls = options.portless
    ? { control: "https://channelstack.localhost", driver: (name) => `https://${name}.localhost` }
    : { control: origin, driver: (name) => `${origin}/${name}` };
  urls = listening;

  let removeAliases = async () => {};
  try {
    if (options.portless) removeAliases = await registerAliases(app.hosts(), Number(server.port));
  } catch (error) {
    await server.stop(true);
    throw error;
  }

  const serverFile = options.serverFile ?? serverFilePath(options.home);
  writePrivateFile(
    serverFile,
    `${JSON.stringify({ url: listening.control, token, pid: process.pid, version: options.version }, null, 2)}\n`,
  );
  log.info("listening", {
    address: `${LOOPBACK}:${server.port}`,
    control: `${listening.control}${CONTROL_PREFIX}`,
    portless: options.portless,
  });

  return {
    urls: listening,
    app,
    async stop() {
      removeFile(serverFile);
      await removeAliases();
      await server.stop(true);
    },
  };
}
