import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { writeSessions } from "../../scripts/lib/live-agents.ts";
import { writeStorageState } from "../../server/src/core/browser/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "channelstack-sessions-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cookie = (value: string) => ({ cookies: [{ name: "d", value, domain: ".slack.com" }] });

// #22: Slack renews a session's cookies while it is used and retires the copy the job started
// with, so a later step of the same job must keep the renewed copy an earlier step saved.
test("the sessions secret fills in what's missing, and leaves a newer saved session alone", () => {
  const home = temp();
  writeStorageState(join(home, "browser", "slack-ana.json"), cookie("renewed"));
  const bundle = JSON.stringify({ "slack-ana.json": cookie("uploaded"), "slack-ben.json": cookie("uploaded") });
  writeSessions({ CHANNELSTACK_BROWSER_SESSIONS: bundle }, home, join(home, "auth"));
  const read = (file: string) => JSON.parse(readFileSync(join(home, "browser", file), "utf8")).cookies[0].value;
  expect(read("slack-ana.json")).toBe("renewed");
  expect(read("slack-ben.json")).toBe("uploaded");
});

const liveSecrets = (home: string) =>
  spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "live-secrets.ts"), "--sessions-only", "--repo", "owner/name", "--dry-run"],
    { env: { PATH: process.env.PATH, CHANNELSTACK_HOME: home }, encoding: "utf8" },
  );

test("--sessions-only sets the sessions secret alone, from the saved sessions, and prints no value", () => {
  const home = temp();
  writeStorageState(join(home, "browser", "slack-ana.json"), cookie("xoxd-secret-value"));
  const run = liveSecrets(home);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("CHANNELSTACK_BROWSER_SESSIONS (secret)");
  expect(run.stdout).not.toMatch(/CHANNELSTACK_SLACK|CHANNELSTACK_GITHUB|Not in live\.env/);
  expect(`${run.stdout}${run.stderr}`).not.toContain("xoxd-secret-value");
});

test("--sessions-only with no saved sessions leaves the secret as it is", () => {
  const run = liveSecrets(temp());
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("stays as it is");
});
