/**
 * Copy the live sandboxes' credentials into the repository's `live` environment, for the nightly
 * job (`.github/workflows/live.yml`). The names come from the workflow itself (`secrets.<NAME>`
 * and `vars.<NAME>`), the values from `~/.channelstack/live.env` (or `$CHANNELSTACK_HOME/live.env`),
 * and the saved browser sessions next to it (`browser/*.json`) as `CHANNELSTACK_BROWSER_SESSIONS`.
 * A secret's value goes to `gh` on its standard input, never as an argument, and nothing prints
 * a value: only names.
 *
 *   node scripts/live-secrets.ts [--env-file <path>] [--repo <owner/name>] [--dry-run]
 *   node scripts/live-secrets.ts --sessions-only [--repo <owner/name>] [--dry-run]
 *
 * `--sessions-only` sets `CHANNELSTACK_BROWSER_SESSIONS` and nothing else: the bundle the run
 * started from (`$CHANNELSTACK_BROWSER_SESSIONS`) with each saved session that differs from it, and
 * only if one does. The nightly job runs it last, with a token that may write the environment's secrets
 * (`CHANNELSTACK_SECRETS_TOKEN`), so the next run starts from the sessions as this one left them:
 * Slack renews a session's cookies while it is used and retires the old copy (#22).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { ROOT } from "./lib/generate.ts";

const ENVIRONMENT = "live";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    repo: { type: "string" },
    "dry-run": { type: "boolean" },
    "sessions-only": { type: "boolean" },
  },
});
const sessionsOnly = values["sessions-only"] === true;
const envFile =
  values["env-file"] ?? join(process.env.CHANNELSTACK_HOME || join(homedir(), ".channelstack"), "live.env");
const dryRun = values["dry-run"] === true;

const fail = (message: string): never => {
  process.stderr.write(`live-secrets: ${message}\n`);
  process.exit(1);
};

/** `gh` with its output captured; a value goes on standard input. */
const gh = (args: readonly string[], input?: string) => {
  const run = spawnSync("gh", args, { input, encoding: "utf8", env: { ...process.env, GH_PAGER: "" } });
  if (run.error) fail(`gh isn't there: ${run.error.message}`);
  return run;
};

// The names the nightly job reads, in the order it lists them.
const workflow = readFileSync(join(ROOT, ".github", "workflows", "live.yml"), "utf8");
const named = (kind: "secrets" | "vars") => [
  ...new Set(
    [...workflow.matchAll(new RegExp(`\\$\\{\\{\\s*${kind}\\.([A-Z0-9_]+)\\s*\\}\\}`, "g"))].map((m) => m[1] as string),
  ),
];
const secrets = sessionsOnly ? ["CHANNELSTACK_BROWSER_SESSIONS"] : named("secrets");
const variables = sessionsOnly ? [] : named("vars");

/** `NAME=value` lines, a value optionally in single or double quotes, as `set -a; . live.env` reads them. */
const env = new Map<string, string>();
// live.env holds credentials: refused if others can read it, as channelstack refuses a saved session.
let mode = 0;
if (!sessionsOnly) {
  try {
    mode = statSync(envFile).mode;
  } catch {
    fail(`no ${envFile}: put the sandboxes' credentials there first (docs/live-mode.md, section 4)`);
  }
}
if (process.platform !== "win32" && (mode & 0o077) !== 0) fail(`${envFile} can be read by others: chmod 600 it`);
for (const line of sessionsOnly ? [] : readFileSync(envFile, "utf8").split("\n")) {
  const found = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!found) continue;
  let value = (found[2] as string).trim();
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0])
    value = value.slice(1, -1);
  if (value !== "") env.set(found[1] as string, value);
}

// The people's saved browser sessions (`channelstack login`), as one secret the nightly job writes
// back to files: `{ "<channel>-<person>.json": <storage state> }`.
const sessions = join(dirname(envFile), "browser");
let bundled: Record<string, unknown> = {};
try {
  for (const file of readdirSync(sessions).filter((name) => name.endsWith(".json"))) {
    const path = join(sessions, file);
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0)
      fail(`${path} can be read by others: chmod 600 it`);
    bundled[file] = JSON.parse(readFileSync(path, "utf8"));
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  bundled = {};
}
if (sessionsOnly) {
  // The bundle the run started from: nobody in it is dropped, and a session this run didn't renew
  // (the browser never opened, or it was signed out and so not saved) stays as it was uploaded.
  let started: Record<string, unknown> = {};
  try {
    started = JSON.parse(process.env.CHANNELSTACK_BROWSER_SESSIONS || "{}") as Record<string, unknown>;
  } catch {
    fail("CHANNELSTACK_BROWSER_SESSIONS isn't JSON: set it again with pnpm live:secrets");
  }
  const renewed = Object.keys(bundled).filter(
    (file) => JSON.stringify(bundled[file]) !== JSON.stringify(started[file]),
  );
  if (renewed.length === 0) {
    process.stdout.write("No browser session was renewed, so CHANNELSTACK_BROWSER_SESSIONS stays as it is.\n");
    process.exit(0);
  }
  process.stdout.write(`Renewed: ${renewed.join(", ")}\n`);
  bundled = { ...started, ...Object.fromEntries(renewed.map((file) => [file, bundled[file]])) };
}
if (Object.keys(bundled).length > 0) {
  const value = JSON.stringify(bundled);
  // GitHub keeps a secret of up to 48 KB.
  if (Buffer.byteLength(value) > 48 * 1024) fail(`the saved browser sessions are over GitHub's 48 KB for a secret`);
  env.set("CHANNELSTACK_BROWSER_SESSIONS", value);
}

const repo =
  values.repo ??
  (() => {
    const run = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (run.status !== 0) fail(`can't tell the repository: ${run.stderr.trim()} (pass --repo <owner/name>)`);
    return run.stdout.trim();
  })();

const set: string[] = [];
const missing: string[] = [];
const failed: string[] = [];

if (!dryRun && !sessionsOnly) {
  // The environment the nightly job runs in; creating it again changes nothing.
  const made = gh(["api", "-X", "PUT", `repos/${repo}/environments/${ENVIRONMENT}`, "--silent"]);
  if (made.status !== 0) fail(`can't create the ${ENVIRONMENT} environment on ${repo}: ${made.stderr.trim()}`);
}

for (const [kind, names] of [
  ["secret", secrets],
  ["variable", variables],
] as const) {
  for (const name of names) {
    const value = env.get(name);
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    if (dryRun) {
      set.push(`${name} (${kind})`);
      continue;
    }
    const run =
      kind === "secret"
        ? gh(["secret", "set", name, "--env", ENVIRONMENT, "--repo", repo], value)
        : gh(["variable", "set", name, "--env", ENVIRONMENT, "--repo", repo], value);
    if (run.status === 0) set.push(`${name} (${kind})`);
    else failed.push(`${name}: ${run.stderr.trim()}`);
  }
}

const lines = [
  `${dryRun ? "Would set" : "Set"} in ${repo}'s ${ENVIRONMENT} environment:`,
  ...set.map((name) => `  ${name}`),
  ...(missing.length > 0 ? ["Not in live.env, so not set (the nightly job skips or fails what needs them):"] : []),
  ...missing.map((name) => `  ${name}`),
  ...(failed.length > 0 ? ["Failed:"] : []),
  ...failed.map((line) => `  ${line}`),
];
process.stdout.write(`${lines.join("\n")}\n`);
if (failed.length > 0) process.exit(1);
