import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createLogger } from "../log/index.ts";
import { Redactor } from "../redact/index.ts";
import { Ledger, ledgerDir, readLedgers, rewriteLedger } from "./index.ts";

function ledger(file?: string, server = "s1") {
  const logs: string[] = [];
  const log = createLogger({ level: "warn", redactor: new Redactor(), write: (line) => logs.push(line) });
  return { ledger: new Ledger({ file, run: "run1", server, clock: () => 1000, log }), logs };
}

const channel = (session: string, id: string) => ({
  channel: "slack",
  kind: "channel",
  ref: { channel: id },
  workspace: "T1",
  by: "user:ANA",
  session,
});

describe("the cleanup ledger", () => {
  test("a session's entries are removed newest first; one that fails stays for the sweep", async () => {
    const { ledger: book, logs } = ledger();
    book.record(channel("a", "C1"));
    book.record(channel("a", "C2"));
    book.record(channel("b", "C3"));
    const seen: string[] = [];
    book.onCleanup("slack", async (entry) => {
      seen.push(entry.ref.channel ?? "");
      if (entry.ref.channel === "C1") throw new Error("Slack refused conversations.archive: not_in_channel");
    });

    expect(await book.cleanup("a")).toEqual({ removed: 1, failed: 1 });
    expect(seen).toEqual(["C2", "C1"]);
    expect(book.entries("a").map((entry) => entry.ref.channel)).toEqual(["C1"]);
    expect(book.entries("b")).toHaveLength(1);
    expect(logs.join("\n")).toContain("channelstack sweep will retry");
  });

  test("ids name the run and the server, so a re-run's entries are told apart", () => {
    const first = ledger(undefined, "s1").ledger.record(channel("a", "C1"));
    const second = ledger(undefined, "s2").ledger.record(channel("a", "C1"));
    expect(first.id).toBe("run1-s1-1");
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({ run: "run1", createdAt: 1000 });
  });

  test("the file is private, outlives the server, and goes away once nothing is left", async () => {
    const home = mkdtempSync(join(tmpdir(), "channelstack-ledger-"));
    const file = join(ledgerDir(home), "123-1.json");
    const { ledger: book } = ledger(file);
    book.onCleanup("slack", async () => {});
    book.record(channel("a", "C1"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const [found] = readLedgers(home);
    expect(found?.file).toBe(file);
    expect(found?.entries.map((entry) => entry.ref.channel)).toEqual(["C1"]);
    // A credential never goes into the file: only whose it is.
    expect(JSON.stringify(found)).toContain('"by":"user:ANA"');

    await book.cleanup("a");
    expect(existsSync(file)).toBe(false);
    expect(readLedgers(home)).toEqual([]);
  });

  test("a sweep rewrites a file with what it couldn't remove, and removes an empty one", () => {
    const home = mkdtempSync(join(tmpdir(), "channelstack-ledger-"));
    const file = join(ledgerDir(home), "123-1.json");
    const { ledger: book } = ledger(file);
    const kept = book.record(channel("a", "C1"));
    book.record(channel("a", "C2"));
    rewriteLedger(file, [kept]);
    expect(readLedgers(home)[0]?.entries).toEqual([kept]);
    rewriteLedger(file, []);
    expect(existsSync(file)).toBe(false);
  });

  test("no home yet: no ledgers", () => {
    expect(readLedgers(join(tmpdir(), "channelstack-nowhere-0000"))).toEqual([]);
  });
});
