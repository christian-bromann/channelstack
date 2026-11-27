import type { LedgerEntry } from "../ledger/index.ts";
import type { LiveCheck, SweepReport } from "../router/index.ts";
import { type Allowlist, taggedRun } from "../safety/index.ts";
import { type LiveCredential, LiveVault } from "../secrets/index.ts";

/**
 * `channelstack doctor` and `sweep` for every driver, written once: a driver's `maintenance.ts`
 * brings only what is its own (which variables, who a credential is, the live world's check of it,
 * how to remove an entry, and its scan for tagged objects).
 */

/** A live credential in the environment, with who it is, or why the platform refused it. */
export interface FoundCredential<Who> {
  readonly variable: string;
  readonly credential: LiveCredential;
  readonly who?: Who;
  readonly problem?: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The people's credentials of a channel in the environment, `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`
 * that are set, in order, each with its owner (`user:<NAME>`).
 */
export function personVariables(
  env: Readonly<Record<string, string | undefined>>,
  channel: string,
): Array<{ variable: string; owner: string }> {
  const person = new RegExp(`^CHANNELSTACK_${channel.toUpperCase()}_USER_([A-Z0-9_]+)_TOKEN$`);
  return Object.keys(env)
    .filter((variable) => person.test(variable) && env[variable])
    .sort()
    .map((variable) => ({ variable, owner: `user:${person.exec(variable)?.[1]}` }));
}

/**
 * A driver's live credentials in the environment: its own (`own`, in order), then every person's
 * (`CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`, owner `user:<NAME>`), each identified.
 */
export async function liveCredentials<Who>(
  env: Readonly<Record<string, string | undefined>>,
  spec: {
    channel: string;
    own: ReadonlyArray<{ variable: string; owner: string }>;
    identify: (credential: LiveCredential) => Promise<Who>;
  },
): Promise<Array<FoundCredential<Who>>> {
  const vault = new LiveVault(env, () => {});
  const people = personVariables(env, spec.channel);
  const found: Array<FoundCredential<Who>> = [];
  for (const { variable, owner } of [...spec.own, ...people]) {
    const credential = vault.fromEnv(variable, owner);
    if (!credential) continue;
    try {
      found.push({ variable, credential, who: await spec.identify(credential) });
    } catch (error) {
      found.push({ variable, credential, problem: message(error) });
    }
  }
  return found;
}

/**
 * `doctor`'s line for each credential: `check` is the live world's own check of it (it throws the
 * refusal), so doctor and a live run never disagree. It answers what to say when the check passes.
 */
export function credentialChecks<Who>(
  found: ReadonlyArray<FoundCredential<Who>>,
  check: (entry: FoundCredential<Who> & { who: Who }) => string,
): LiveCheck[] {
  return found.map((entry) => {
    const shown = `${entry.variable} (${entry.credential.prefix()}…)`;
    if (entry.who === undefined) return { ok: false, text: `${shown}: ${entry.problem}` };
    try {
      return { ok: true, text: `${shown}: ${check(entry as FoundCredential<Who> & { who: Who })}` };
    } catch (error) {
      return { ok: false, text: `${shown}: ${message(error)}` };
    }
  });
}

/**
 * The ledger's part of a sweep: what crashed runs recorded, newest first, in allowlisted places only.
 * With `check`, each is only reported.
 */
export async function sweepLedger(
  entries: readonly LedgerEntry[],
  options: {
    allowlist: Allowlist;
    check: boolean;
    describe: (entry: LedgerEntry) => string;
    remove: (entry: LedgerEntry) => Promise<void>;
  },
): Promise<SweepReport> {
  const report: SweepReport = { removed: [], left: [], done: [] };
  for (const entry of [...entries].reverse()) {
    const what = `${options.describe(entry)} (run ${entry.run})`;
    if (!options.allowlist.allows(entry.workspace)) {
      report.left.push(`${what}: ${entry.workspace} isn't in ${options.allowlist.variable}`);
    } else if (options.check) {
      report.left.push(what);
    } else {
      try {
        await options.remove(entry);
        report.removed.push(what);
        report.done.push(entry);
      } catch (error) {
        report.left.push(`${what}: ${message(error)}`);
      }
    }
  }
  return report;
}

/**
 * The tagged part of a sweep: objects with a run's tag in their name that no ledger lists, the
 * run's own at any age, or every run's older than the cutoff. What a ledger entry names (`known`)
 * was swept or reported already. `remove` answers why it couldn't remove one, if it couldn't.
 */
export async function sweepTagged<Item>(
  report: SweepReport,
  items: Iterable<Item>,
  options: {
    entries: readonly LedgerEntry[];
    run: string | undefined;
    olderThanMs: number;
    now: number;
    check: boolean;
    /** Its tagged name, as people read it. */
    name: (item: Item) => string;
    /** Whether a ledger entry names it. */
    known: (item: Item, entry: LedgerEntry) => boolean;
    createdAt: (item: Item) => number;
    remove: (item: Item) => Promise<string | undefined>;
  },
): Promise<SweepReport> {
  for (const item of items) {
    const name = options.name(item);
    const tagged = taggedRun(name);
    if (tagged === undefined || options.entries.some((entry) => options.known(item, entry))) continue;
    if (
      options.run !== undefined ? tagged !== options.run : options.now - options.createdAt(item) < options.olderThanMs
    )
      continue;
    if (options.check) {
      report.left.push(name);
      continue;
    }
    try {
      const unremoved = await options.remove(item);
      if (unremoved === undefined) report.removed.push(name);
      else report.left.push(`${name}: ${unremoved}`);
    } catch (error) {
      report.left.push(`${name}: ${message(error)}`);
    }
  }
  return report;
}
