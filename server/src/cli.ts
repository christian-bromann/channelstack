#!/usr/bin/env bun
import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { CONTROL_PREFIX } from "./app.ts";
import { actionOptionNames, runChannel } from "./cli/act.ts";
import { attach, type Attached } from "./cli/attach.ts";
import { runDeliveries, runRedeliver } from "./cli/deliveries.ts";
import { runShow } from "./cli/dev.ts";
import { runDoctor, runLogin, runSweep } from "./cli/live.ts";
import { runMcp } from "./cli/mcp.ts";
import { runOpenAI } from "./cli/openai.ts";
import { runTail } from "./cli/watch.ts";
import { appWebhookVariable } from "./core/apps/index.ts";
import { rotateCa } from "./core/ca/index.ts";
import { homeDir } from "./core/home/index.ts";
import { parseSeed } from "./core/ids/index.ts";
import { parseLogLevel } from "./core/log/index.ts";
import { randomSeed, Secrets } from "./core/secrets/index.ts";
import { DEV_CHANNELS, DRIVERS, proxyHosts, secretSpecs } from "./drivers/index.ts";
import { start } from "./serve.ts";
import { UI_PAGE } from "./ui/page.ts";

const USAGE = `channelstack ${pkg.version}

Usage:
  channelstack [start]            Start the server (fake Slack, GitHub, Linear, Notion, Resend, Google, Discord
                                  and OpenAI in memory)
      --no-portless               One loopback port with path prefixes, instead of *.localhost names
      --port <n>                  The loopback port (default 4500 without portless; 0 picks a free one)
      --server-file <path>        Where to write the control API's URL and token (default <home>/server.json)
      --log-level <level>         debug, info, warn, error or silent (default info)
      --proxy                     Also run an HTTP proxy for agents with hard-coded hosts: slack.com, api.github.com,
                                  api.linear.app, api.notion.com, api.resend.com, Google's googleapis.com hosts,
                                  discord.com and api.openai.com go to the fakes, every other host passes through
      --proxy-port <n>            The proxy's loopback port (default 7464; 0 picks a free one)
      --record <dir>              With --proxy: write the shape of every exchange with those hosts, and of every
                                  webhook, to <dir>/shapes.jsonl (structure only, never a value)
  channelstack env                Print .env lines for the agent, from the running server
      --proxy                     For proxy mode: HTTPS_PROXY and the CA the agent trusts, instead of the API URLs
      --app <name>                Another app's lines, under the same keys (made the first time it is asked for)
      --channel <name>            Only that channel's lines
  channelstack ca rotate          Replace proxy mode's CA (<home>/ca); restart the server and run \`channelstack env --proxy\`

  Attached to the running server (a shared "dev" session; people and places are created on first use).
  <channel> is slack, github, linear, notion, resend, google or discord; a place is a Slack channel, a GitHub
  issue, a Linear issue, a Notion page, an email thread or a Discord channel, by its name:
  channelstack <channel> say   --as <name> --in <place> "<text>"
  channelstack <channel> reply --as <name> [--to last|<ref>] "<text>"
  channelstack <channel> react --as <name> <emoji> [--on last|<ref>]
  channelstack <channel> show  [--in <place>] [--thread last|<ref>] [--json]   A place as a person reads it
  channelstack <channel> actions                What else its people do (click, stop, review, delegate, …)
  channelstack <channel> <action> [--as <name>] [--in <place>] [--on last|<ref>] [<value>…] [--<value> <v>…]
                                  One of those, e.g. \`channelstack slack click --as ana Approve\`
  channelstack show [--thread last] [--json]    The most recently active place on any channel
  channelstack tail [--once]                    Events to the agent and its API calls, as they happen
  channelstack deliveries [<channel>]           What was delivered to the agent: ids, events, outcomes, attempts
  channelstack openai respond "<text>"          Script the fake OpenAI's answer in the dev session (templates:
      [--when <text>] [--times <n>]             {lastUserText}, {toolResult}); --tool <name> --args <json> calls a
      [--tool <name> --args <json>]             tool first, and the text answers its result
  channelstack openai calls                     The dev session's model calls, one a line
  channelstack openai undo <script>             Remove a script
  channelstack redeliver [<channel>] [last|<id>]   Deliver it again, the way the platform does (Slack retries it)
  channelstack mcp                              These commands as MCP tools over stdio, for a coding agent
  channelstack ui                               A one-time link that opens the UI in a browser
      --server <url>              The server to attach to (default: the one in server.json; also CHANNELSTACK_URL
                                  with CHANNELSTACK_TOKEN)

  Live mode (credentials in the environment; see docs/live-mode.md):
  channelstack doctor             Which channels run live, whether their credentials work and are allowlisted,
                                  and whether saved browser sessions are still signed in
      --storage-state <path>      A saved browser session to check, besides those in <home>/browser
  channelstack login slack --user <name>   Sign a sandbox person in by hand, once, in a browser window, and save the
                                  session for the browser actor (<home>/browser/slack-<name>.json, 0600)
      --save <path>               Also save it here, e.g. .auth/ana-slack.json for a test that names it
  channelstack sweep              Remove what crashed live runs left: their ledgers' objects, and tagged channels
      --older-than-hours <n>      Only tagged objects older than this (default 24)
      --run <id>                  Only what this run made, of any age
      --check                     Remove nothing; exit 1 if anything is left

  channelstack secrets rotate     Replace every fake token and signing secret
  channelstack --version
  channelstack --help

Environment:
  CHANNELSTACK_HOME               State directory (default ~/.channelstack)
  CHANNELSTACK_SEED               Makes generated ids reproducible
  CHANNELSTACK_<DRIVER>_WEBHOOK_URL   Where the agent receives that driver's events
  CHANNELSTACK_<DRIVER>_APP_<NAME>_WEBHOOK_URL   Where another app's events go (coder is CODER)
`;

const DEFAULT_PORT = 4500;
/** Proxy mode's port, fixed so the `HTTPS_PROXY` line in an agent's `.env` stays right across restarts. */
const DEFAULT_PROXY_PORT = 7464;

/** A port flag's value, or the default when it isn't given. */
function portFlag(name: string, value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--${name} must be a port number, got "${value}"`);
  return port;
}

function fail(message: string): never {
  process.stderr.write(`channelstack: ${message}\n`);
  process.exit(1);
}

async function runStart(flags: {
  "no-portless"?: boolean;
  port?: string;
  "server-file"?: string;
  "log-level"?: string;
  proxy?: boolean;
  "proxy-port"?: string;
  record?: string;
}) {
  const portless = !flags["no-portless"];
  const port = portFlag("port", flags.port, portless ? 0 : DEFAULT_PORT);
  const proxyPort = flags.proxy ? portFlag("proxy-port", flags["proxy-port"], DEFAULT_PROXY_PORT) : undefined;
  if (!flags.proxy && flags["proxy-port"] !== undefined) fail("--proxy-port needs --proxy");
  if (!flags.proxy && flags.record !== undefined) fail("--record needs --proxy");

  // The signals are caught before the server exists: its token file appears while it starts, and a
  // signal that arrives right then must still end in a clean stop, not a file left behind.
  let stopRequested = false;
  let stop = () => {
    stopRequested = true;
  };
  // SIGHUP is what a closed terminal tab sends: it must clean up like the others.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop());

  const seed = process.env.CHANNELSTACK_SEED;
  const running = await start({
    version: pkg.version,
    home: homeDir(),
    portless,
    port,
    ...(proxyPort === undefined ? {} : { proxyPort }),
    ...(flags.record === undefined ? {} : { recordDir: flags.record }),
    serverFile: flags["server-file"] ?? process.env.CHANNELSTACK_SERVER_FILE,
    seed: seed ? parseSeed(seed) : randomSeed(),
    logLevel: parseLogLevel(flags["log-level"] ?? process.env.CHANNELSTACK_LOG_LEVEL),
    ui: UI_PAGE,
    env: process.env,
    webhooks: Object.fromEntries(
      DRIVERS.map((driver) => [
        driver.name,
        process.env[`CHANNELSTACK_${driver.name.toUpperCase()}_WEBHOOK_URL`] || undefined,
      ]),
    ),
    appWebhooks: (driver, app) => process.env[appWebhookVariable(driver, app)] || undefined,
  }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

  const lines = [
    `channelstack ${pkg.version} · in-memory`,
    "",
    `  Control  ${running.urls.control}${CONTROL_PREFIX}`,
    ...DRIVERS.map((driver) => `  ${driver.name.padEnd(8)} ${running.urls.driver(driver.name)}`),
    ...(running.urls.proxy ? [`  Proxy    ${running.urls.proxy.url}  (CA ${running.urls.proxy.caFile})`] : []),
    // A one-time link: it signs this browser in. `channelstack ui` prints a fresh one.
    `  UI       ${running.app.uiLoginLink()}`,
    "",
    running.urls.proxy
      ? "  `channelstack env --proxy` prints tokens, the proxy and the CA as .env lines"
      : "  `channelstack env` prints tokens and URLs as .env lines",
    "",
  ];
  process.stdout.write(lines.join("\n"));

  let stopping = false;
  stop = () => {
    if (stopping) return;
    stopping = true;
    running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  if (stopRequested) stop();
}

/** `channelstack env`: asks the running server, so the URLs match how it was started. */
async function runEnv(
  server: Attached,
  options: { proxy: boolean; app: string | undefined; channel: string | undefined },
) {
  const query = new URLSearchParams();
  if (options.proxy) query.set("proxy", "true");
  if (options.app !== undefined) query.set("app", options.app);
  if (options.channel !== undefined) query.set("channel", options.channel);
  const env = await server.request<Record<string, string>>("GET", query.size > 0 ? `/env?${query}` : "/env");
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

async function runCa(action: string | undefined) {
  if (action !== "rotate") fail(`unknown ca command "${action ?? ""}". Did you mean \`channelstack ca rotate\`?`);
  const ca = await rotateCa(homeDir(), proxyHosts());
  process.stdout.write(
    `Replaced proxy mode's CA (${ca.caFile}). Restart the server; agents trust the new one from the same files.\n`,
  );
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
      // The values the channels' actions take, by name (`--button Approve`, `--issue last`); the
      // commands' own options below come after, so none of them is taken for a value.
      ...Object.fromEntries(actionOptionNames().map((name) => [name, { type: "string" as const }])),
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      "no-portless": { type: "boolean" },
      port: { type: "string" },
      "server-file": { type: "string" },
      "log-level": { type: "string" },
      proxy: { type: "boolean" },
      app: { type: "string" },
      channel: { type: "string" },
      "proxy-port": { type: "string" },
      record: { type: "string" },
      server: { type: "string" },
      as: { type: "string" },
      in: { type: "string" },
      thread: { type: "string" },
      on: { type: "string" },
      to: { type: "string" },
      json: { type: "boolean" },
      once: { type: "boolean" },
      "storage-state": { type: "string", multiple: true },
      "older-than-hours": { type: "string" },
      run: { type: "string" },
      check: { type: "boolean" },
      user: { type: "string" },
      save: { type: "string" },
      when: { type: "string" },
      times: { type: "string" },
      tool: { type: "string" },
      args: { type: "string" },
    },
  });
  if (values.version) return void process.stdout.write(`${pkg.version}\n`);
  if (values.help) return void process.stdout.write(USAGE);

  const [command = "start", action, ...rest] = positionals;
  if (command === "start") return runStart(values);
  if (command === "secrets") return runSecrets(action);
  if (command === "ca") return runCa(action);
  if (command === "login") {
    const result = await runLogin({
      env: process.env,
      home: homeDir(),
      drivers: DRIVERS,
      channel: action,
      user: values.user,
      save: values.save,
    });
    process.stdout.write(result.text);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "doctor" || command === "sweep") {
    const live = { env: process.env, home: homeDir(), drivers: DRIVERS };
    const result =
      command === "doctor"
        ? await runDoctor({ ...live, storageStates: values["storage-state"] ?? [] })
        : await runSweep({
            ...live,
            check: values.check === true,
            run: values.run,
            olderThanHours: values["older-than-hours"],
          });
    process.stdout.write(result.text);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  // Everything else attaches to the running server.
  const print = (text: string) => void process.stdout.write(text);
  if (command === "env") {
    return print(
      await runEnv(attach(values), { proxy: values.proxy === true, app: values.app, channel: values.channel }),
    );
  }
  if (DEV_CHANNELS.some((channel) => channel.name === command))
    return print(await runChannel(attach(values), command, action, rest, values));
  if (command === "ui") {
    const { url } = await attach(values).request<{ url: string }>("POST", "/ui/login-links");
    return print(`${url}\n`);
  }
  if (command === "show") return print(await runShow(attach(values), undefined, values));
  if (command === "tail") return runTail(attach(values), values, print);
  if (command === "deliveries") return print(await runDeliveries(attach(values), action));
  if (command === "redeliver")
    return print(await runRedeliver(attach(values), [action, ...rest].filter(Boolean) as string[]));
  // Attaches on its first tool call, so a coding agent can start it before the server.
  if (command === "mcp") return runMcp(values, pkg.version);
  if (command === "openai") {
    const { when, times, tool, args } = values;
    return print(await runOpenAI(attach(values), action, rest, { when, times, tool, args }));
  }
  fail(`unknown command "${command}". Run \`channelstack --help\`.`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
