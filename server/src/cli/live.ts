import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { systemTimers } from "../core/clock/index.ts";
import { readLedgers, rewriteLedger } from "../core/ledger/index.ts";
import type { DriverDefinition, LiveCheck } from "../core/router/index.ts";
import { isRunId } from "../core/safety/index.ts";
import { CliError } from "./attach.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface LiveCommandInput {
  env: Env;
  home: string;
  drivers: readonly DriverDefinition[];
  /** For unit tests: a stand-in for the platforms, and the time. */
  fetch?: typeof fetch;
  apiBase?: Readonly<Record<string, string>>;
  now?: number;
}

/** How a driver stands with live mode, from its declared credentials alone. */
function liveState(definition: DriverDefinition, env: Env): { set: string[]; missing: string[] } {
  const credentials = definition.live?.credentials ?? [];
  return {
    set: credentials.filter((name) => env[name]),
    missing: credentials.filter((name) => !env[name]),
  };
}

/** A saved browser session (storage state): private to its owner, with cookies that haven't expired. */
function storageStateCheck(path: string, now: number): LiveCheck {
  let mode: number;
  let state: { cookies?: Array<{ expires?: number }> };
  try {
    mode = statSync(path).mode;
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not there" : "not a saved browser session";
    return { ok: false, text: `${path}: ${reason}` };
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    return { ok: false, text: `${path}: others can read it; it holds a signed-in session (chmod 600)` };
  }
  const cookies = state.cookies ?? [];
  // `expires` is in seconds; -1 (or none) is a cookie for the browser's session, which a saved state can't keep.
  const valid = cookies.filter((cookie) => typeof cookie.expires === "number" && cookie.expires * 1000 > now);
  if (valid.length === 0) {
    return { ok: false, text: `${path}: expired; sign in again to save a new session` };
  }
  const until = new Date(Math.min(...valid.map((cookie) => (cookie.expires as number) * 1000))).toISOString();
  return { ok: true, text: `${path}: signed in, the first cookie expires ${until}` };
}

/** The saved browser sessions to check: the given paths, and every one in `<home>/browser`. */
function storageStates(home: string, given: readonly string[]): string[] {
  let saved: string[] = [];
  try {
    saved = readdirSync(join(home, "browser"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(home, "browser", name));
  } catch {
    // No saved sessions yet.
  }
  return [...new Set([...given, ...saved])];
}

/**
 * `channelstack doctor`: what each channel would be (fake or live), whether its live credentials
 * work and are allowlisted, and whether saved browser sessions are still signed in. It prints
 * variable names and token prefixes, never a credential. Exits 1 when something live is wrong.
 */
export async function runDoctor(input: LiveCommandInput & { storageStates: readonly string[] }): Promise<{
  text: string;
  ok: boolean;
}> {
  const lines: string[] = [];
  let ok = true;
  const mark = (check: LiveCheck) => {
    if (!check.ok) ok = false;
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.text}`);
  };
  const reality = input.env.CHANNELSTACK_REALITY;
  if (reality === "fake") lines.push("CHANNELSTACK_REALITY=fake: every channel runs fake, credentials or not", "");

  for (const definition of input.drivers.filter((candidate) => candidate.live)) {
    const live = definition.live;
    if (!live) continue;
    const { set, missing } = liveState(definition, input.env);
    lines.push(definition.name);
    if (reality === "fake") {
      lines.push("  fake  CHANNELSTACK_REALITY=fake");
      continue;
    }
    if (set.length === 0) {
      lines.push(`  fake  set ${live.credentials.join(" and ")} to run it live`);
      continue;
    }
    if (missing.length > 0) {
      mark({ ok: false, text: `${missing.join(", ")} not set, so ${definition.name} can't run live` });
      continue;
    }
    if (!input.env[live.allowlist]) mark({ ok: false, text: `${live.allowlist} is empty: live mode acts nowhere` });
    if (!live.maintenance) {
      mark({ ok: false, text: `live ${definition.name} isn't built yet: its steps are skipped (unsupported_in_live)` });
      continue;
    }
    const checks = await live.maintenance.doctor({
      env: input.env,
      fetch: input.fetch ?? fetch,
      timers: systemTimers,
      ...(input.apiBase?.[definition.name] ? { apiBase: input.apiBase[definition.name] } : {}),
    });
    for (const check of checks) mark(check);
  }

  const states = storageStates(input.home, input.storageStates);
  lines.push("browser sessions");
  if (states.length === 0) lines.push("  none saved (the browser actor needs one per person for UI-only actions)");
  for (const path of states) mark(storageStateCheck(path, input.now ?? Date.now()));
  return { text: `${lines.join("\n")}\n`, ok };
}

/** Is the server that wrote this ledger file still running? Its own sessions remove what they made. */
function running(file: string): boolean {
  const pid = Number(basename(file).split("-")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `channelstack sweep`: remove what live runs left behind. That is what crashed servers' ledgers
 * still list, and channels carrying a run's tag that nobody archived: older than
 * `--older-than-hours` (24), or any age with `--run <id>`. Only in allowlisted workspaces. With `--check`, nothing is
 * removed, and it exits 1 if anything is left (the nightly job's check, exit check 5.2).
 */
export async function runSweep(
  input: LiveCommandInput & { check: boolean; run: string | undefined; olderThanHours: string | undefined },
): Promise<{ text: string; ok: boolean }> {
  const hours = Number(input.olderThanHours ?? "24");
  if (!Number.isFinite(hours) || hours < 0) {
    throw new CliError(`--older-than-hours takes a number of hours, got "${input.olderThanHours}"`);
  }
  const olderThanMs = hours * 3_600_000;
  if (input.run !== undefined && !isRunId(input.run)) throw new CliError(`--run takes a run id, got "${input.run}"`);
  const ledgers = readLedgers(input.home).filter((ledger) => !running(ledger.file));
  // What each file still lists, as the drivers remove theirs. Entries are matched as read from their
  // own file, so two servers' entries with the same id never stand in for each other.
  const kept = new Map(ledgers.map((ledger) => [ledger.file, [...ledger.entries]]));
  const lines: string[] = [];
  let left = 0;
  for (const definition of input.drivers) {
    const maintenance = definition.live?.maintenance;
    const { missing } = liveState(definition, input.env);
    const entries = ledgers
      .flatMap((ledger) => ledger.entries)
      .filter((entry) => entry.channel === definition.name && (input.run === undefined || entry.run === input.run));
    if (!maintenance || missing.length > 0) {
      // What a ledger lists and nothing here can look at is still there, as far as anyone knows.
      const why = maintenance ? `${missing.join(", ")} not set` : `live ${definition.name} isn't built`;
      for (const entry of entries) {
        lines.push(
          `${definition.name}: can't look at ${entry.kind} ${entry.ref.name ?? entry.ref.channel ?? ""} (run ${entry.run}): ${why}`,
        );
        left++;
      }
      continue;
    }
    const report = await maintenance.sweep({
      env: input.env,
      fetch: input.fetch ?? fetch,
      timers: systemTimers,
      ...(input.apiBase?.[definition.name] ? { apiBase: input.apiBase[definition.name] } : {}),
      entries,
      check: input.check,
      run: input.run,
      olderThanMs,
      now: input.now ?? Date.now(),
    });
    for (const list of kept.values()) {
      for (const done of report.done) {
        const at = list.indexOf(done);
        if (at !== -1) list.splice(at, 1);
      }
    }
    left += report.left.length;
    for (const what of report.removed) lines.push(`${definition.name}: removed ${what}`);
    for (const what of report.left)
      lines.push(`${definition.name}: ${input.check ? "left" : "couldn't remove"} ${what}`);
  }
  for (const ledger of ledgers) {
    const list = kept.get(ledger.file) ?? [];
    if (list.length !== ledger.entries.length) rewriteLedger(ledger.file, list);
  }
  if (lines.length === 0) lines.push(input.check ? "Nothing left behind." : "Nothing to remove.");
  return { text: `${lines.join("\n")}\n`, ok: left === 0 };
}
