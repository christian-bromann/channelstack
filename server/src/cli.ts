#!/usr/bin/env bun
import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { CONTROL_PREFIX } from "./app.ts";
import { attach, type Attached } from "./cli/attach.ts";
import { runSlack } from "./cli/slack.ts";
import { runShow, runTail } from "./cli/watch.ts";
import { homeDir } from "./core/home/index.ts";
import { parseSeed } from "./core/ids/index.ts";
import { parseLogLevel } from "./core/log/index.ts";
import { randomSeed, Secrets } from "./core/secrets/index.ts";
import { DRIVERS, secretSpecs } from "./drivers/index.ts";
import { start } from "./serve.ts";
import { UI_PAGE } from "./ui/page.ts";

const USAGE = `channelstack ${pkg.version}

Usage:
  channelstack [start]            Start the server (fake Slack, GitHub, Linear and Notion in memory)
      --no-portless               One loopback port with path prefixes, instead of *.localhost names
      --port <n>                  The loopback port (default 4500 without portless; 0 picks a free one)
      --server-file <path>        Where to write the control API's URL and token (default <home>/server.json)
      --log-level <level>         debug, info, warn, error or silent (default info)
  channelstack env                Print .env lines for the agent, from the running server

  Attached to the running server (a shared "dev" session; people and channels are created on first use):
  channelstack slack say   --as <name> --in "#channel" "<text>"
  channelstack slack reply --as <name> [--thread last] "<text>"
  channelstack slack react --as <name> <:emoji:> [--on last]
  channelstack slack click --as <name> "<button>"       The button in the latest message that has it
  channelstack slack stop  [--as <name>] [--thread last]   Press Stop on the agent's work in a thread
  channelstack show [--thread last] [--json]    The latest conversation as a person would read it
  channelstack tail [--once]                    Events to the agent and its API calls, as they happen
  channelstack ui                               A one-time link that opens the UI in a browser
      --server <url>              The server to attach to (default: the one in server.json; also CHANNELSTACK_URL
                                  with CHANNELSTACK_TOKEN)

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

async function runStart(flags: {
  "no-portless"?: boolean;
  port?: string;
  "server-file"?: string;
  "log-level"?: string;
}) {
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
    ui: UI_PAGE,
    webhooks: Object.fromEntries(
      DRIVERS.map((driver) => [
        driver.name,
        process.env[`CHANNELSTACK_${driver.name.toUpperCase()}_WEBHOOK_URL`] || undefined,
      ]),
    ),
  }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  const lines = [
    `channelstack ${pkg.version} · in-memory`,
    "",
    `  Control  ${running.urls.control}${CONTROL_PREFIX}`,
    ...DRIVERS.map((driver) => `  ${driver.name.padEnd(8)} ${running.urls.driver(driver.name)}`),
    // A one-time link: it signs this browser in. `channelstack ui` prints a fresh one.
    `  UI       ${running.app.uiLoginLink()}`,
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
  // SIGHUP is what a closed terminal tab sends: it must clean up like the others.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
}

/** `channelstack env`: asks the running server, so the URLs match how it was started. */
async function runEnv(server: Attached) {
  const env = await server.request<Record<string, string>>("GET", "/env");
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function runSecrets(action: string | undefined) {
  if (action !== "rotate")
    fail(`unknown secrets command "${action ?? ""}". Did you mean \`channelstack secrets rotate\`?`);
  Secrets.rotate(homeDir(), secretSpecs());
  process.stdout.write(
    "Rotated every fake token and signing secret. Restart the server and run `channelstack env` again.\n",
  );
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
      server: { type: "string" },
      as: { type: "string" },
      in: { type: "string" },
      thread: { type: "string" },
      on: { type: "string" },
      json: { type: "boolean" },
      once: { type: "boolean" },
    },
  });
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help) return void process.stdout.write(USAGE);

  const [command = "start", action, ...rest] = positionals;
  if (command === "start") return runStart(values);
  if (command === "secrets") return runSecrets(action);

  // Everything else attaches to the running server.
  const print = (text: string) => void process.stdout.write(text);
  if (command === "env") return print(await runEnv(attach(values)));
  if (command === "slack") return print(await runSlack(attach(values), action, rest, values));
  if (command === "ui") {
    const { url } = await attach(values).request<{ url: string }>("POST", "/ui/login-links");
    return print(`${url}\n`);
  }
  if (command === "show") return print(await runShow(attach(values), values));
  if (command === "tail") return runTail(attach(values), values, print);
  fail(`unknown command "${command}". Run \`channelstack --help\`.`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
