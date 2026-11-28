#!/usr/bin/env bun
import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { CONTROL_PREFIX } from "./app.ts";
import { runChannel } from "./cli/act.ts";
import { attach, type Attached, type AttachFlags } from "./cli/attach.ts";
import { runDeliveries, runRedeliver } from "./cli/deliveries.ts";
import { type DevFlags, runShow } from "./cli/dev.ts";
import { closest, type Command, commandLine, find, flagsOf, parseOptions, renderHelp } from "./cli/help.ts";
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

async function runStart(flags: Flags) {
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

async function runCa() {
  const ca = await rotateCa(homeDir(), proxyHosts());
  process.stdout.write(
    `Replaced proxy mode's CA (${ca.caFile}). Restart the server; agents trust the new one from the same files.\n`,
  );
}

function runSecrets() {
  Secrets.rotate(homeDir(), secretSpecs());
  process.stdout.write(
    "Rotated every fake token and signing secret. Restart the server and run `channelstack env` again.\n",
  );
}

/** The flags, once `checkFlags` has made sure each has the type its command declares. */
interface Flags extends DevFlags, AttachFlags {
  readonly [name: string]: unknown;
  readonly "no-portless"?: boolean;
  readonly port?: string;
  readonly "log-level"?: string;
  readonly proxy?: boolean;
  readonly "proxy-port"?: string;
  readonly record?: string;
  readonly app?: string;
  readonly channel?: string;
  readonly once?: boolean;
  readonly "storage-state"?: string[];
  readonly "older-than-hours"?: string;
  readonly run?: string;
  readonly check?: boolean;
  readonly user?: string;
  readonly save?: string;
  readonly when?: string;
  readonly times?: string;
  readonly tool?: string;
  readonly args?: string;
}

/** A command's help, bold headings only on a terminal that wants colour. */
const help = (path: readonly Command[]) =>
  renderHelp(path, {
    version: pkg.version,
    style: { bold: process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb" },
  });

/** Refuse a flag the command doesn't take, naming the one that was probably meant. */
function checkFlags(path: readonly Command[], values: Record<string, unknown>) {
  const command = path.at(-1) as Command;
  const line = commandLine(path);
  const flags = flagsOf(command);
  for (const [name, value] of Object.entries(values)) {
    const flag = flags.get(name);
    if (!flag) {
      const meant = closest(
        name,
        [...flags.values()].filter((known) => !known.hidden).map((known) => known.name),
      );
      fail(
        `${line} takes no --${name}.${meant ? ` Did you mean --${meant}?` : ""} Run \`${line} --help\` for its flags.`,
      );
    }
    const values = Array.isArray(value) ? value : [value];
    if (flag.value && values.some((one) => typeof one !== "string"))
      fail(`--${name} needs a value: --${name} <${flag.value}>. Run \`${line} --help\`.`);
    if (!flag.value && values.some((one) => typeof one !== "boolean"))
      fail(`--${name} is a switch and takes no value. Run \`${line} --help\`.`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    // Flags are checked against the command that was found, below, with a message that says what it takes.
    strict: false,
    options: parseOptions(),
  });
  if (values.version && positionals.length === 0) return void process.stdout.write(`${pkg.version}\n`);

  // `channelstack help <command…>` is `channelstack <command…> --help`.
  const asked = positionals[0] === "help";
  const words = asked ? positionals.slice(1) : positionals;
  const found = find(words);
  if (!found.ok) {
    const at = commandLine(found.path);
    const meant = found.suggestion ? ` Did you mean \`${at} ${found.suggestion}\`?` : "";
    fail(`unknown command "${found.typed}" for \`${at}\`.${meant} Run \`${at} --help\` for its commands.`);
  }
  // Help never acts and never attaches: it prints and exits 0.
  if (asked || values.help) return void process.stdout.write(help(found.path));
  // A group named alone (`channelstack slack`, `channelstack openai`) shows what it holds.
  const group = found.path.length > 1 && (found.path.at(-1)?.commands?.length ?? 0) > 0;
  if (group && found.path.length > words.length) return void process.stdout.write(help(found.path));
  // No command is `start`.
  const path = found.path.length > 1 ? found.path : (find(["start"]) as { path: readonly Command[] }).path;
  checkFlags(path, values);
  const flags = values as Flags;

  const [command = "start", action, ...rest] = positionals;
  if (command === "start") return runStart(flags);
  if (command === "secrets") return runSecrets();
  if (command === "ca") return runCa();
  if (command === "login") {
    const result = await runLogin({
      env: process.env,
      home: homeDir(),
      drivers: DRIVERS,
      channel: action,
      user: flags.user,
      save: flags.save,
    });
    process.stdout.write(result.text);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "doctor" || command === "sweep") {
    const live = { env: process.env, home: homeDir(), drivers: DRIVERS };
    const result =
      command === "doctor"
        ? await runDoctor({ ...live, storageStates: flags["storage-state"] ?? [] })
        : await runSweep({
            ...live,
            check: flags.check === true,
            run: flags.run,
            olderThanHours: flags["older-than-hours"],
          });
    process.stdout.write(result.text);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  // Everything else attaches to the running server.
  const print = (text: string) => void process.stdout.write(text);
  if (command === "env") {
    return print(await runEnv(attach(flags), { proxy: flags.proxy === true, app: flags.app, channel: flags.channel }));
  }
  if (DEV_CHANNELS.some((channel) => channel.name === command))
    return print(await runChannel(attach(flags), command, action, rest, flags));
  if (command === "ui") {
    const { url } = await attach(flags).request<{ url: string }>("POST", "/ui/login-links");
    return print(`${url}\n`);
  }
  if (command === "show") return print(await runShow(attach(flags), undefined, flags));
  if (command === "tail") return runTail(attach(flags), flags, print);
  if (command === "deliveries") return print(await runDeliveries(attach(flags), action));
  if (command === "redeliver")
    return print(await runRedeliver(attach(flags), [action, ...rest].filter(Boolean) as string[]));
  // Attaches on its first tool call, so a coding agent can start it before the server.
  if (command === "mcp") return runMcp(flags, pkg.version);
  if (command === "openai") {
    const { when, times, tool, args } = flags;
    return print(await runOpenAI(attach(flags), action, rest, { when, times, tool, args }));
  }
  fail(`unknown command "${command}". Run \`channelstack --help\`.`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
