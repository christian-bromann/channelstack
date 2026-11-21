import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { homeDir, readJsonFile, removeFile, writePrivateFile } from "./index.ts";

const posix = process.platform !== "win32";

describe("state directory", () => {
  test("CHANNELSTACK_HOME overrides ~/.channelstack", () => {
    expect(homeDir({ CHANNELSTACK_HOME: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    expect(homeDir({})).toMatch(/\.channelstack$/);
  });

  test.runIf(posix)("exit check 0.6: private files are created with mode 0600 in a 0700 directory", () => {
    const home = join(mkdtempSync(join(tmpdir(), "cs-home-")), "nested");
    const file = join(home, "server.json");

    writePrivateFile(file, "{}");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test.runIf(posix)("exit check 0.6: rewriting a file that was world-readable makes it private", () => {
    const home = mkdtempSync(join(tmpdir(), "cs-home-"));
    const file = join(home, "secrets.json");
    writeFileSync(file, "{}", { mode: 0o644 });

    writePrivateFile(file, '{"a":1}');

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readJsonFile(file)).toEqual({ a: 1 });
  });

  test("a missing file reads as undefined, and removing it twice is fine", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cs-home-")), "missing.json");
    expect(readJsonFile(file)).toBeUndefined();
    removeFile(file);
    removeFile(file);
  });
});
