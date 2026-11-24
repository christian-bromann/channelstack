import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { slackStub } from "../../test/slack-live-stub.ts";
import { writePrivateFile } from "../core/home/index.ts";
import { DRIVERS } from "../drivers/index.ts";
import { runDoctor, runSweep } from "./live.ts";

const home = () => mkdtempSync(join(tmpdir(), "channelstack-live-"));

/** A Slack sandbox as the environment describes it: the app, Ana, and the allowlist. */
function sandbox(options: { allowlist?: string } = {}) {
  const stub = slackStub();
  const ana = stub.person("ana");
  const env = {
    CHANNELSTACK_SLACK_APP_ID: "A0STUBAPP1",
    CHANNELSTACK_SLACK_BOT_TOKEN: stub.bot.token,
    CHANNELSTACK_SLACK_USER_ANA_TOKEN: ana.token,
    CHANNELSTACK_LIVE_SLACK_TEAMS: options.allowlist ?? stub.team,
  };
  return { stub, ana, env, live: { drivers: DRIVERS, fetch: stub.fetch, apiBase: { slack: stub.apiBase } } };
}

describe("exit check 5.6: channelstack doctor", () => {
  test("checks the live credentials and the allowlist, and shows token prefixes only", async () => {
    const { stub, ana, env, live } = sandbox();
    const { text, ok } = await runDoctor({ ...live, env, home: home(), storageStates: [] });
    expect(ok).toBe(true);
    expect(text).toContain(`ok    CHANNELSTACK_SLACK_BOT_TOKEN (xoxb-…): the app's bot in workspace ${stub.team}`);
    expect(text).toContain(`ok    CHANNELSTACK_SLACK_USER_ANA_TOKEN (xoxp-…): a person in workspace ${stub.team}`);
    expect(text).toContain("fake  set CHANNELSTACK_GITHUB_APP_ID and CHANNELSTACK_GITHUB_PRIVATE_KEY to run it live");
    expect(text).not.toContain(stub.bot.token);
    expect(text).not.toContain(ana.token);
  });

  test("a workspace outside the allowlist, and a channel without its live backend, fail", async () => {
    const { env, live } = sandbox({ allowlist: "T0SOMEWHERE" });
    const { text, ok } = await runDoctor({
      ...live,
      env: { ...env, CHANNELSTACK_NOTION_TOKEN: "a stand-in" },
      home: home(),
      storageStates: [],
    });
    expect(ok).toBe(false);
    expect(text).toMatch(
      /FAIL {2}CHANNELSTACK_SLACK_BOT_TOKEN \(xoxb-…\): Slack workspace T0STUB0001 isn't in CHANNELSTACK_LIVE_SLACK_TEAMS/,
    );
    expect(text).toContain("FAIL  CHANNELSTACK_LIVE_NOTION_WORKSPACES is empty");
    expect(text).toContain("FAIL  live notion isn't built yet");
  });

  test("CHANNELSTACK_REALITY=fake: every channel is fake, and that is no failure", async () => {
    const { stub, env, live } = sandbox();
    const { text, ok } = await runDoctor({
      ...live,
      env: { ...env, CHANNELSTACK_REALITY: "fake", CHANNELSTACK_LINEAR_APP_TOKEN: "a stand-in" },
      home: home(),
      storageStates: [],
    });
    expect(ok).toBe(true);
    expect(text).toContain("fake  CHANNELSTACK_REALITY=fake");
    expect(stub.calls).toEqual([]);
  });

  test("saved browser sessions: private, and still signed in", async () => {
    const { env, live } = sandbox();
    const dir = home();
    const now = Date.UTC(2026, 10, 23);
    const state = (cookieExpires: number) =>
      JSON.stringify({ cookies: [{ name: "d", value: "x", expiry: cookieExpires }] });
    mkdirSync(join(dir, "browser"));
    writePrivateFile(join(dir, "browser", "slack-ana.json"), state(now / 1000 + 86_400));
    writePrivateFile(join(dir, "browser", "notion-ana.json"), state(now / 1000 - 1));
    const shared = join(dir, "shared.json");
    writeFileSync(shared, state(now / 1000 + 86_400));
    chmodSync(shared, 0o644);

    const { text, ok } = await runDoctor({ ...live, env, home: dir, storageStates: [shared], now });
    expect(ok).toBe(false);
    expect(text).toContain(`ok    ${join(dir, "browser", "slack-ana.json")}: signed in`);
    expect(text).toContain(`FAIL  ${join(dir, "browser", "notion-ana.json")}: expired`);
    expect(text).toContain(`FAIL  ${shared}: others can read it`);
  });
});

describe("exit check 5.2: channelstack sweep", () => {
  /** What a crashed server's ledger holds: a channel Ana made in run `crash1`. */
  async function crashedRun() {
    const s = sandbox();
    const dir = home();
    const created = await s.stub.fetch(`${s.stub.apiBase}/conversations.create`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.ana.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "channelstack-run-crash1-1" }),
    });
    const { channel } = (await created.json()) as { channel: { id: string; created: number } };
    // A pid no process has: the server that wrote it is gone.
    writePrivateFile(
      join(dir, "ledger", "999999999-1.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "crash1-1",
            channel: "slack",
            kind: "channel",
            ref: { channel: channel.id, name: "channelstack-run-crash1-1" },
            workspace: s.stub.team,
            by: "user:ANA",
            run: "crash1",
            session: "ses_x",
            createdAt: 0,
          },
        ],
      }),
    );
    return { ...s, dir, channel };
  }

  test("--check lists what a run left, and the sweep removes it from the platform and the ledger", async () => {
    const { stub, env, live, dir, channel } = await crashedRun();
    const now = (channel.created + 3600) * 1000;

    const checked = await runSweep({
      ...live,
      env,
      home: dir,
      check: true,
      run: "crash1",
      olderThanHours: undefined,
      now,
    });
    expect(checked.ok).toBe(false);
    expect(checked.text).toContain("slack: left channel channelstack-run-crash1-1 (run crash1)");
    expect(checked.text).toContain("slack: left channel #channelstack-run-crash1-1");
    expect(stub.channel(channel.id)?.archived).toBe(false);

    const swept = await runSweep({
      ...live,
      env,
      home: dir,
      check: false,
      run: undefined,
      olderThanHours: undefined,
      now,
    });
    expect(swept.ok).toBe(true);
    expect(swept.text).toContain("slack: removed channel channelstack-run-crash1-1 (run crash1)");
    expect(stub.channel(channel.id)?.archived).toBe(true);
    expect(existsSync(join(dir, "ledger", "999999999-1.json"))).toBe(false);

    const after = await runSweep({
      ...live,
      env,
      home: dir,
      check: true,
      run: "crash1",
      olderThanHours: undefined,
      now,
    });
    expect(after).toEqual({ ok: true, text: "Nothing left behind.\n" });
  });

  test("a tagged channel no ledger knows is removed once it is older than the cutoff", async () => {
    const { stub, ana, env, live } = sandbox();
    const dir = home();
    const made = await stub.fetch(`${stub.apiBase}/conversations.create`, {
      method: "POST",
      headers: { authorization: `Bearer ${ana.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "channelstack-run-old1-3-support" }),
    });
    const { channel } = (await made.json()) as { channel: { id: string; created: number } };
    const sweep = (hoursLater: number) =>
      runSweep({
        ...live,
        env,
        home: dir,
        check: false,
        run: undefined,
        olderThanHours: "24",
        now: (channel.created + hoursLater * 3600) * 1000,
      });

    expect((await sweep(2)).text).toBe("Nothing to remove.\n");
    expect(stub.channel(channel.id)?.archived).toBe(false);
    expect((await sweep(25)).text).toContain("slack: removed channel #channelstack-run-old1-3-support");
    expect(stub.channel(channel.id)?.archived).toBe(true);
  });

  test("nothing outside the allowlist is touched", async () => {
    const { stub, env, live, dir, channel } = await crashedRun();
    const report = await runSweep({
      ...live,
      env: { ...env, CHANNELSTACK_LIVE_SLACK_TEAMS: "T0ELSEWHERE" },
      home: dir,
      check: false,
      run: "crash1",
      olderThanHours: undefined,
      now: Date.now(),
    });
    // It is still there, so the sweep says so: it isn't "nothing".
    expect(report.ok).toBe(false);
    expect(report.text).toContain("isn't in CHANNELSTACK_LIVE_SLACK_TEAMS");
    expect(stub.channel(channel.id)?.archived).toBe(false);
    expect(stub.calls.filter((call) => call.method === "conversations.archive")).toEqual([]);
  });

  test("what a ledger lists for a channel without credentials here is reported, not passed over", async () => {
    const { dir, live } = await crashedRun();
    const report = await runSweep({
      ...live,
      env: {},
      home: dir,
      check: true,
      run: "crash1",
      olderThanHours: undefined,
      now: Date.now(),
    });
    expect(report.ok).toBe(false);
    expect(report.text).toContain(
      "slack: can't look at channel channelstack-run-crash1-1 (run crash1): CHANNELSTACK_SLACK_APP_ID, CHANNELSTACK_SLACK_BOT_TOKEN not set",
    );
  });

  test("two crashed servers of the same run with the same entry id: each entry is removed on its own", async () => {
    const { stub, env, live, dir, channel } = await crashedRun();
    // A re-run of the same CI job: another server, the same run id, the same counter.
    const made = await stub.fetch(`${stub.apiBase}/conversations.create`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CHANNELSTACK_SLACK_USER_ANA_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name: "channelstack-run-crash1-1-again" }),
    });
    const { channel: again } = (await made.json()) as { channel: { id: string } };
    const second = join(dir, "ledger", "999999998-1.json");
    writePrivateFile(
      second,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "crash1-1",
            channel: "slack",
            kind: "channel",
            ref: { channel: again.id, name: "channelstack-run-crash1-1-again" },
            workspace: stub.team,
            by: "user:NOBODY",
            run: "crash1",
            session: "ses_y",
            createdAt: 0,
          },
        ],
      }),
    );
    // Nobody's token removes the second: it must stay in its file, not vanish with the first.
    const report = await runSweep({
      ...live,
      env,
      home: dir,
      check: false,
      run: "crash1",
      olderThanHours: undefined,
      now: Date.now(),
    });
    expect(stub.channel(channel.id)?.archived).toBe(true);
    expect(report.text).toContain("couldn't remove channel channelstack-run-crash1-1-again");
    expect(existsSync(join(dir, "ledger", "999999999-1.json"))).toBe(false);
    expect(readFileSync(second, "utf8")).toContain(again.id);
  });
});
