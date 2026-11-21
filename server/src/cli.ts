#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { CONTROL_PREFIX } from "./app.ts";
import { homeDir, readJsonFile } from "./core/home/index.ts";
import { parseSeed } from "./core/ids/index.ts";
import { parseLogLevel } from "./core/log/index.ts";
import { randomSeed, Secrets } from "./core/secrets/index.ts";
import { DRIVERS, secretSpecs } from "./drivers/index.ts";
import { serverFilePath, start } from "./serve.ts";

const USAGE = `channelstack ${pkg.version}

Usage:
  channelstack [start]            Start the server (fake Slack, GitHub, Linear and Notion in memory)
      --no-portless               One loopback port with path prefixes, instead of *.localhost names
      --port <n>                  The loopback port (default 4500 without portless; 0 picks a free one)
      --server-file <path>        Where to write the control API's URL and token (default <home>/server.json)
      --log-level <level>         debug, info, warn, error or silent (default info)
  channelstack env                Print .env lines for the agent, from the running server
  channelstack secrets rotate     Replace every fake token and signing secret
  channelstack --version
  channelstack --help

Environment:
  CHANNELSTACK_HOME               State directory (default ~/.channelstack)
  CHANNELSTACK_SEED               Makes generated ids reproducible
  CHANNELSTACK_<DRIVER>_WEBHOOK_URL   Where the agent receives that driver's events
`;

const DEFAULT_PORT = 4500;

function fail(message: string): never {
  process.stderr.write(`channelstack: ${message}\n`);
  process.exit(1);
}

async function runStart(flags: { "no-portless"?: boolean; port?: string; "server-file"?: string; "log-level"?: string }) {
  const portless = !flags["no-portless"];
  const port = flags.port === undefined ? (portless ? 0 : DEFAULT_PORT) : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, got "${flags.port}"`);

  const seed = process.env.CHANNELSTACK_SEED;
  const running = await start({
    version: pkg.version,
    home: homeDir(),
    portless,
    port,
    serverFile: flags["server-file"] ?? process.env.CHANNELSTACK_SERVER_FILE,
    seed: seed ? parseSeed(seed) : randomSeed(),
    logLevel: parseLogLevel(flags["log-level"] ?? process.env.CHANNELSTACK_LOG_LEVEL),
    webhooks: Object.fromEntries(
      DRIVERS.map((driver) => [driver.name, process.env[`CHANNELSTACK_${driver.name.toUpperCase()}_WEBHOOK_URL`] || undefined]),
    ),
  }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  const lines = [
    `channelstack ${pkg.version} · in-memory`,
    "",
    `  Control  ${running.urls.control}${CONTROL_PREFIX}`,
    ...DRIVERS.map((driver) => `  ${driver.name.padEnd(8)} ${running.urls.driver(driver.name)}`),
    "",
    "  `channelstack env` prints tokens and URLs as .env lines",
    "",
  ];
  process.stdout.write(lines.join("\n"));

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** `channelstack env`: asks the running server, so the URLs match how it was started. */
async function runEnv(flags: { "server-file"?: string }) {
  const file = flags["server-file"] ?? process.env.CHANNELSTACK_SERVER_FILE ?? serverFilePath(homeDir());
  const server = readJsonFile(file) as { url?: string; token?: string } | undefined;
  if (!server?.url || !server.token) fail("no running server found. Start one with `channelstack start`.");
  const response = await fetch(`${server.url}${CONTROL_PREFIX}/env`, { headers: { authorization: `Bearer ${server.token}` } }).catch(() =>
    fail(`the server at ${server.url} isn't reachable. Start one with \`channelstack start\`.`),
  );
  if (!response.ok) fail(`the server at ${server.url} refused the request (${response.status}).`);
  const env = (await response.json()) as Record<string, string>;
  process.stdout.write(`${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function runSecrets(action: string | undefined) {
  if (action !== "rotate") fail(`unknown secrets command "${action ?? ""}". Did you mean \`channelstack secrets rotate\`?`);
  Secrets.rotate(homeDir(), secretSpecs());
  process.stdout.write("Rotated every fake token and signing secret. Restart the server and run `channelstack env` again.\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      "no-portless": { type: "boolean" },
      port: { type: "string" },
      "server-file": { type: "string" },
      "log-level": { type: "string" },
    },
  });
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help) return void process.stdout.write(USAGE);

  const [command = "start", action] = positionals;
  if (command === "start") return runStart(values);
  if (command === "env") return runEnv(values);
  if (command === "secrets") return runSecrets(action);
  fail(`unknown command "${command}". Run \`channelstack --help\`.`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
