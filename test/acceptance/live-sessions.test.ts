import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * `pnpm live:secrets --sessions-only` as the nightly job runs it last, against a stand-in `gh` that
 * writes down each call: its arguments, and what it got on standard input.
 */
function liveSecrets(home: string, started: Record<string, unknown>) {
  const bin = temp();
  const log = join(bin, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf 'ARGS %s\\n' "$*" >> "${log}"\ncat >> "${log}"\nprintf '\\nEND\\n' >> "${log}"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "live-secrets.ts"), "--sessions-only", "--repo", "owner/name"],
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CHANNELSTACK_HOME: home,
        CHANNELSTACK_BROWSER_SESSIONS: JSON.stringify(started),
      },
      encoding: "utf8",
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\nEND\n")
        .filter((call) => call.trim() !== "")
        .map((call) => {
          const [args = "", ...stdin] = call.replace(/^ARGS /, "").split("\n");
          return { args, stdin: stdin.join("\n") };
        })
    : [];
  return { ...run, calls };
}

test("--sessions-only uploads the renewed sessions over the bundle the run started from, and prints no value", () => {
  const home = temp();
  writeStorageState(join(home, "browser", "slack-ana.json"), cookie("xoxd-renewed"));
  writeStorageState(join(home, "browser", "slack-ben.json"), cookie("xoxd-ben"));
  const started = {
    "slack-ana.json": cookie("xoxd-started"),
    "slack-ben.json": cookie("xoxd-ben"),
    "slack-cy.json": cookie("xoxd-cy"),
  };
  const run = liveSecrets(home, started);
  expect(run.status).toBe(0);
  // One call, and only `secret set`: no environment created, no other secret touched.
  expect(run.calls.map((call) => call.args)).toEqual([
    "secret set CHANNELSTACK_BROWSER_SESSIONS --env live --repo owner/name",
  ]);
  // Ana's renewed session; Ben's as it was; Cy, whom this run didn't have, kept.
  expect(JSON.parse(run.calls[0]?.stdin ?? "")).toEqual({
    "slack-ana.json": cookie("xoxd-renewed"),
    "slack-ben.json": cookie("xoxd-ben"),
    "slack-cy.json": cookie("xoxd-cy"),
  });
  expect(run.stdout).toContain("Renewed: slack-ana.json");
  expect(`${run.stdout}${run.stderr}`).not.toContain("xoxd-");
});

test("--sessions-only with nothing renewed, or nothing saved, leaves the secret as it is", () => {
  const unchanged = temp();
  writeStorageState(join(unchanged, "browser", "slack-ana.json"), cookie("xoxd-started"));
  for (const home of [unchanged, temp()]) {
    const run = liveSecrets(home, { "slack-ana.json": cookie("xoxd-started") });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain("stays as it is");
  }
});
