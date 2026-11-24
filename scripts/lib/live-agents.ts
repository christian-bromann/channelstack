/**
 * The live run's side of the agents (`scripts/live.ts`): each channel's reference agent, started
 * here against the real platform, and the people's saved browser sessions where the browser actor
 * looks. channelstack never relays events to an agent: Slack's agent connects to Slack itself
 * (Socket Mode), and GitHub, Notion and Linear send their webhooks to a smee.io channel, which a
 * smee client forwards to the agent here. That is the platform's delivery, taken from the relay
 * the platform was pointed at; nothing in it passes through channelstack.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import SmeeClient from "smee-client";

import { type StorageState, writeStorageState } from "../../server/src/core/browser/index.ts";
import { ROOT } from "./generate.ts";
import { freePort } from "./process.ts";

type Env = NodeJS.ProcessEnv;
type Stop = () => Promise<unknown>;

const say = (line: string) => process.stdout.write(`${line}\n`);

/** A reference agent with only its own configuration: none of channelstack's environment reaches it. */
function spawnAgent(
  dir: string,
  agentEnv: Record<string, string>,
  stops: Stop[],
  output: "pipe" | "ignore" = "ignore",
): ChildProcess {
  // Its output is read only where it says it is ready; a pipe nobody reads would fill and stall it.
  const agent = spawn(process.execPath, [join(ROOT, "examples", "agents", dir, "agent.ts")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...agentEnv },
    stdio: ["ignore", output, "inherit"],
  });
  const exited = new Promise<void>((resolve) => agent.once("exit", () => resolve()));
  stops.push(async () => {
    if (agent.exitCode === null) agent.kill("SIGTERM");
    await exited;
  });
  return agent;
}

/** The agent answers HTTP on its port: it can take deliveries. */
async function listening(name: string, agent: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (agent.exitCode !== null) throw new Error(`The ${name} agent exited with ${agent.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`The ${name} agent didn't listen on port ${port} in 30s`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const isRelay = (url: string | undefined) => {
  try {
    return url !== undefined && new URL(url).host === "smee.io";
  } catch {
    return false;
  }
};

/**
 * A platform's webhooks, from its relay channel to the agent here. A channel's URL is never
 * printed: anyone who has it can read the events.
 */
async function relay(name: string, source: string, target: string, stops: Stop[]): Promise<void> {
  const smee = new SmeeClient({
    source,
    target,
    logger: {
      info: () => {},
      // The reason, never a URL: the relay channel's is a secret.
      error: (error: unknown) => {
        const failed = error as { code?: string; cause?: { code?: string }; name?: string } | undefined;
        const reason = failed?.cause?.code ?? failed?.code ?? failed?.name ?? "unknown";
        process.stderr.write(`${name}: forwarding a delivery to the agent failed (${reason})\n`);
      },
    },
  });
  await smee.start();
  stops.push(() => smee.stop());
}

/** An agent that takes webhooks: started on a free port, then its relay channel forwarded to it. */
async function webhookAgent(
  name: string,
  options: { dir: string; path: string; source: string; env: Record<string, string> },
  stops: Stop[],
): Promise<void> {
  const port = await freePort();
  const agent = spawnAgent(options.dir, { ...options.env, PORT: String(port) }, stops);
  await listening(name, agent, port);
  await relay(name, options.source, `http://127.0.0.1:${port}${options.path}`, stops);
  say(`${name}: the reference agent takes the platform's webhooks through its relay channel`);
}

/** Every channel's reference agent whose configuration is in the environment. Says why one doesn't run. */
export async function startAgents(env: Env, stops: Stop[]): Promise<void> {
  // Slack: the reference agent connects to real Slack itself, in Socket Mode.
  if (env.CHANNELSTACK_SLACK_BOT_TOKEN && env.CHANNELSTACK_SLACK_APP_TOKEN) {
    const agent = spawnAgent(
      "bolt-ai-sdk",
      {
        SLACK_BOT_TOKEN: env.CHANNELSTACK_SLACK_BOT_TOKEN,
        SLACK_APP_TOKEN: env.CHANNELSTACK_SLACK_APP_TOKEN,
        SLACK_SOCKET_MODE: "1",
      },
      stops,
      "pipe",
    );
    // The agent says when its socket to Slack is up.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The Slack agent didn't connect to Slack in 30s")), 30_000);
      agent.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Bolt app is running")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      agent.once("exit", (code) => reject(new Error(`The Slack agent exited with ${code}`)));
    });
  } else say("Slack: no CHANNELSTACK_SLACK_BOT_TOKEN and CHANNELSTACK_SLACK_APP_TOKEN, so no agent runs here");

  // GitHub: the App's webhook goes to the relay channel the App names.
  const appId = env.CHANNELSTACK_GITHUB_APP_ID;
  const key = env.CHANNELSTACK_GITHUB_PRIVATE_KEY;
  const secret = env.CHANNELSTACK_GITHUB_WEBHOOK_SECRET;
  if (appId && key && secret) {
    const app = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey: key.replaceAll("\\n", "\n") },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const { url } = (await app.request("GET /app/hook/config")).data as { url?: string };
    if (!isRelay(url)) {
      say(
        "GitHub: the App's webhook isn't a smee.io channel, so no agent runs here; its live example needs one elsewhere",
      );
    } else {
      await webhookAgent(
        "GitHub",
        {
          dir: "probot",
          path: "/api/github/webhooks",
          source: url as string,
          env: { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY: key, GITHUB_WEBHOOK_SECRET: secret, LOG_LEVEL: "warn" },
        },
        stops,
      );
    }
  } else if (appId && key) say("GitHub: no CHANNELSTACK_GITHUB_WEBHOOK_SECRET, so no agent runs here");

  // Notion: the integration's webhook subscription goes to CHANNELSTACK_NOTION_RELAY_URL.
  const notion = env.CHANNELSTACK_NOTION_TOKEN;
  if (notion && env.CHANNELSTACK_NOTION_VERIFICATION_TOKEN && isRelay(env.CHANNELSTACK_NOTION_RELAY_URL)) {
    await webhookAgent(
      "Notion",
      {
        dir: "notion-sdk",
        path: "/webhooks/notion",
        source: env.CHANNELSTACK_NOTION_RELAY_URL as string,
        env: { NOTION_TOKEN: notion, NOTION_VERIFICATION_TOKEN: env.CHANNELSTACK_NOTION_VERIFICATION_TOKEN },
      },
      stops,
    );
  } else if (notion) {
    say(
      "Notion: no CHANNELSTACK_NOTION_VERIFICATION_TOKEN and smee.io CHANNELSTACK_NOTION_RELAY_URL, so no agent runs here",
    );
  }

  // Linear: the app's webhook (agent session events) goes to CHANNELSTACK_LINEAR_RELAY_URL.
  const linear = env.CHANNELSTACK_LINEAR_APP_TOKEN;
  if (linear && env.CHANNELSTACK_LINEAR_WEBHOOK_SECRET && isRelay(env.CHANNELSTACK_LINEAR_RELAY_URL)) {
    await webhookAgent(
      "Linear",
      {
        dir: "linear-sdk",
        path: "/webhooks/linear",
        source: env.CHANNELSTACK_LINEAR_RELAY_URL as string,
        env: { LINEAR_ACCESS_TOKEN: linear, LINEAR_WEBHOOK_SECRET: env.CHANNELSTACK_LINEAR_WEBHOOK_SECRET },
      },
      stops,
    );
  } else if (linear) {
    say(
      "Linear: no CHANNELSTACK_LINEAR_WEBHOOK_SECRET and smee.io CHANNELSTACK_LINEAR_RELAY_URL, so no agent runs here",
    );
  }
}

/** A saved session's file name: `<channel>-<person>.json`, as `channelstack login` names it. */
const SESSION_FILE = /^([a-z]+)-([a-z0-9][a-z0-9._-]*)\.json$/;

/**
 * The people's saved browser sessions from `CHANNELSTACK_BROWSER_SESSIONS` (the nightly job's
 * secret, `{ "<channel>-<person>.json": <storage state> }`): where the server looks for them, and
 * where `channelstack login --save` puts a test's own copy (`.auth/<person>-<channel>.json`)
 * unless one is there. Each file is private (0600).
 */
export function writeSessions(env: Env, home: string): void {
  const bundle = env.CHANNELSTACK_BROWSER_SESSIONS;
  if (!bundle) return;
  let sessions: Record<string, StorageState>;
  try {
    sessions = JSON.parse(bundle) as Record<string, StorageState>;
  } catch {
    throw new Error("CHANNELSTACK_BROWSER_SESSIONS isn't JSON: set it again with pnpm live:secrets");
  }
  for (const [file, state] of Object.entries(sessions)) {
    const named = SESSION_FILE.exec(file);
    if (!named)
      throw new Error(`CHANNELSTACK_BROWSER_SESSIONS has a session named "${file}", not <channel>-<person>.json`);
    writeStorageState(join(home, "browser", file), state);
    const copy = join(ROOT, ".auth", `${named[2]}-${named[1]}.json`);
    if (!existsSync(copy)) writeStorageState(copy, state);
  }
}
