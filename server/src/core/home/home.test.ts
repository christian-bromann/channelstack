import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { homeDir, processRunning, readPrivateJsonFile, removeFile, writePrivateFile } from "./index.ts";

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
    expect(readPrivateJsonFile(file)).toEqual({ a: 1 });
  });

  test("a state file that isn't JSON is an error that names the file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cs-home-")), "server.json");
    writeFileSync(file, "{not json");
    expect(() => readPrivateJsonFile(file)).toThrow(`${file} is not valid JSON`);
  });

  test("a missing file reads as undefined, and removing it twice is fine", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cs-home-")), "missing.json");
    expect(readPrivateJsonFile(file)).toBeUndefined();
    removeFile(file);
    removeFile(file);
  });

  test("a state file's writer is running while its process is, and not once it has exited", () => {
    expect(processRunning(process.pid)).toBe(true);
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(processRunning(ended)).toBe(false);
    expect(processRunning(Number.NaN)).toBe(false);
  });
});
