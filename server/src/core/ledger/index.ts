import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "../clock/index.ts";
import { readPrivateJsonFile, removeFile, writePrivateFile } from "../home/index.ts";
import type { Logger } from "../log/index.ts";

/**
 * One object a live session created on a real platform. It names whose credential removes it, never
 * the credential itself, so the file a crashed run leaves behind holds no secret.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly channel: string;
  /** What it is, in the driver's words: `channel`, `message`. */
  readonly kind: string;
  /** The platform's ids for it. */
  readonly ref: Readonly<Record<string, string>>;
  /** The workspace, org or team it is in. */
  readonly workspace: string;
  /** Whose credential removes it: `app`, or `user:<NAME>` for `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`. */
  readonly by: string;
  readonly run: string;
  readonly session: string;
  readonly createdAt: number;
}

export type NewLedgerEntry = Omit<LedgerEntry, "id" | "createdAt" | "run">;

/** Removes one object from its platform. Throws when it couldn't; the entry then stays for `channelstack sweep`. */
export type CleanupHandler = (entry: LedgerEntry) => Promise<void>;

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/** Where every server keeps its ledger: one file per server, so two servers never overwrite each other's. */
export function ledgerDir(home: string): string {
  return join(home, "ledger");
}

function parse(raw: unknown): LedgerEntry[] {
  const entries = (raw as Partial<LedgerFile> | undefined)?.entries;
  return Array.isArray(entries) ? entries : [];
}

/**
 * The cleanup ledger (implementation plan 12.4): everything live sessions create is recorded here
 * and removed, newest first, when its session closes. The file outlives a crash, and
 * `channelstack sweep` removes what it still lists.
 */
export class Ledger {
  readonly #file: string | undefined;
  readonly #run: string;
  readonly #server: string;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #entries: LedgerEntry[] = [];
  readonly #handlers = new Map<string, CleanupHandler>();
  #next = 0;

  /** Without a file the ledger is kept in memory only (unit tests, and servers that never go live). */
  /** `server` tells this server's entries from another's of the same run (a re-run of a CI job). */
  constructor(options: { file: string | undefined; run: string; server: string; clock: Clock; log: Logger }) {
    this.#file = options.file;
    this.#run = options.run;
    this.#server = options.server;
    this.#clock = options.clock;
    this.#log = options.log;
  }

  get run(): string {
    return this.#run;
  }

  /** How a driver removes the objects it records. */
  onCleanup(channel: string, handler: CleanupHandler): void {
    this.#handlers.set(channel, handler);
  }

  record(entry: NewLedgerEntry): LedgerEntry {
    const recorded: LedgerEntry = {
      ...entry,
      id: `${this.#run}-${this.#server}-${++this.#next}`,
      run: this.#run,
      createdAt: this.#clock(),
    };
    this.#entries.push(recorded);
    this.#save();
    return recorded;
  }

  /** Forget an entry without removing its object: the object is gone already (a message the test deleted). */
  forget(matches: (entry: LedgerEntry) => boolean): void {
    const kept = this.#entries.filter((entry) => !matches(entry));
    if (kept.length === this.#entries.length) return;
    this.#entries.splice(0, this.#entries.length, ...kept);
    this.#save();
  }

  entries(session?: string): readonly LedgerEntry[] {
    return session === undefined ? [...this.#entries] : this.#entries.filter((entry) => entry.session === session);
  }

  /**
   * Remove what a session created, newest first: a message before the channel it is in. What
   * couldn't be removed stays in the ledger and is logged, without the platform's answer.
   */
  async cleanup(session: string): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    for (const entry of [...this.entries(session)].reverse()) {
      const handler = this.#handlers.get(entry.channel);
      if (!handler) continue;
      try {
        await handler(entry);
        this.forget((candidate) => candidate.id === entry.id);
        removed++;
      } catch (error) {
        failed++;
        this.#log.warn("live cleanup failed; channelstack sweep will retry", {
          channel: entry.channel,
          kind: entry.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { removed, failed };
  }

  #save(): void {
    if (this.#file === undefined) return;
    if (this.#entries.length === 0) {
      removeFile(this.#file);
      return;
    }
    writePrivateFile(
      this.#file,
      `${JSON.stringify({ version: 1, entries: this.#entries } satisfies LedgerFile, null, 2)}\n`,
    );
  }
}

/** Every entry the servers of this install left behind, with the file each came from (for `channelstack sweep`). */
export function readLedgers(home: string): Array<{ file: string; entries: LedgerEntry[] }> {
  const dir = ledgerDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .map((file) => ({ file, entries: parse(readPrivateJsonFile(file)) }));
}

/** Write what is left of a ledger file after a sweep: the entries that still couldn't be removed. */
export function rewriteLedger(file: string, entries: readonly LedgerEntry[]): void {
  if (entries.length === 0) removeFile(file);
  else
    writePrivateFile(file, `${JSON.stringify({ version: 1, entries: [...entries] } satisfies LedgerFile, null, 2)}\n`);
}
