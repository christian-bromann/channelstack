import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { harness } from "./app-harness.ts";
import { slackStub } from "./slack-live-stub.ts";

/**
 * Exit check 5.4: every row of docs/reality-matrix.md whose Live column is "No" or "Not yet" is
 * refused live with `unsupported_in_live`, before anything reaches the platform. The rows are read
 * from the matrix itself, so a new fake-only row without a case here fails this test.
 */

interface MatrixRow {
  section: string;
  feature: string;
  live: string;
}

function fakeOnlyRows(): MatrixRow[] {
  const matrix = readFileSync(new URL("../../docs/reality-matrix.md", import.meta.url), "utf8");
  const rows: MatrixRow[] = [];
  let section = "";
  for (const line of matrix.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) section = heading[1] as string;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 6 || cells[1] === "Feature" || /^-+$/.test(cells[1] ?? "")) continue;
    const live = cells[3] ?? "";
    if (/^(No|Not yet)\b/.test(live)) rows.push({ section, feature: cells[1] as string, live });
  }
  return rows;
}

/** How each fake-only row is exercised: the channel, and the control call a test's step makes. */
type Case = { channel: string; method: string; path: string; body?: unknown; reason?: RegExp };
const CASES: Record<string, Case | Case[]> = {
  "`createUser({ id })` (fixed id)": {
    channel: "slack",
    method: "POST",
    path: "/users",
    body: { name: "Ana", id: "U0FIXED0001" },
  },
  "`delivery.attempts`, `status`, `settled()`": [
    { channel: "slack", method: "GET", path: "/deliveries/E0X" },
    { channel: "linear", method: "GET", path: "/deliveries/x" },
    { channel: "notion", method: "GET", path: "/deliveries/x" },
  ],
  // The matchers read the delivery: the same refusal, the same skip.
  "`toBeAccepted({ within })`": { channel: "slack", method: "GET", path: "/deliveries/E0X" },
  "`toBeRejected()`": { channel: "notion", method: "GET", path: "/deliveries/x" },
  "`delivery.resend({ badSignature, stale })`": [
    { channel: "slack", method: "POST", path: "/deliveries/E0X/resend", body: { badSignature: true } },
    { channel: "linear", method: "POST", path: "/deliveries/x/resend", body: { stale: true } },
  ],
  "`channelstack reset`": { channel: "", method: "POST", path: "/reset", reason: /never wiped/ },
  "`slack.createChannel({ shared: true })` (Slack Connect)": {
    channel: "slack",
    method: "POST",
    path: "/channels",
    body: { shared: true, participants: [] },
    reason: /Slack Connect/,
  },
  "`slack.uninstallApp()`": { channel: "slack", method: "POST", path: "/uninstall", reason: /OAuth consent/ },
  '`delivery.retry({ after: "3s" })`': { channel: "slack", method: "POST", path: "/deliveries/E0X/retry", body: {} },
  // GitHub's live backend isn't built: every GitHub operation is refused, these among them.
  "`ana.assign(github.app, { issue })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/assign",
    body: { assignees: ["1"], issue: { repoId: "1", number: 1 } },
  },
  "`ana.requestReview(github.app, { pr })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/request-review",
    body: { reviewers: ["1"], pr: { repoId: "1", number: 1 } },
  },
  "`ana.rerun({ checkRun })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/rerun",
    body: { checkRun: 1 },
    reason: /Re-run is a click/,
  },
  "`delivery.redeliver()`": {
    channel: "linear",
    method: "POST",
    path: "/deliveries/x/redeliver",
    reason: /no API to redeliver/,
  },
  "`ana.resolve` / `reopen` (discussion)": [
    { channel: "notion", method: "POST", path: "/users/x/resolve", body: { discussion: "d" }, reason: /resolve/ },
    { channel: "notion", method: "POST", path: "/users/x/reopen", body: { discussion: "d" }, reason: /resolve/ },
  ],
  "`discussion.resolved()`": { channel: "notion", method: "GET", path: "/discussions/d/resolved", reason: /resolved/ },
  "`delivery.resend()` / redelivery": [
    { channel: "notion", method: "POST", path: "/deliveries/x/resend", body: {} },
    { channel: "notion", method: "POST", path: "/deliveries/x/redeliver", reason: /no API to redeliver/ },
  ],
  "`notion.setContentUpdateDelay(delay)`": {
    channel: "notion",
    method: "POST",
    path: "/content-delay",
    body: { delay: 0 },
    reason: /batches/,
  },
  "`notion.sendVerification()`": { channel: "notion", method: "POST", path: "/verification", reason: /verification/ },
};

/** Every driver live: Slack against the stub, the others with credentials set and no live backend yet. */
function liveEverywhere() {
  const stub = slackStub();
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_SLACK_APP_ID: "A0STUBAPP1",
          CHANNELSTACK_SLACK_BOT_TOKEN: stub.bot.token,
          CHANNELSTACK_LIVE_SLACK_TEAMS: stub.team,
          CHANNELSTACK_GITHUB_APP_ID: "1",
          CHANNELSTACK_GITHUB_PRIVATE_KEY: "not-a-key",
          CHANNELSTACK_LINEAR_APP_TOKEN: "not-a-token",
          CHANNELSTACK_NOTION_TOKEN: "not-a-token",
        },
        fetch: stub.fetch,
        apiBase: { slack: stub.apiBase },
      },
    },
  );
  return { stub, server };
}

describe("exit check 5.4: fake-only features say so", () => {
  const rows = fakeOnlyRows();

  test("the matrix has fake-only rows, and every one has a case here", () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.map((row) => row.feature).filter((feature) => !(feature in CASES))).toEqual([]);
  });

  test.each(rows)("$section: $feature is refused live with unsupported_in_live", async ({ feature }) => {
    const { stub, server } = liveEverywhere();
    const { body: session } = await server.call("POST", "/sessions", {});
    for (const step of [CASES[feature] ?? []].flat()) {
      const path = step.channel === "" ? step.path : `/sessions/${session.sessionId}/${step.channel}${step.path}`;
      const reply = await server.call(step.method, path, step.body);
      expect(reply.status, `${step.method} ${path}: ${JSON.stringify(reply.body)}`).toBe(501);
      expect(reply.body.error).toBe("unsupported_in_live");
      expect(reply.body.message).toMatch(step.reason ?? /isn't supported live: ./);
    }
    // Refused before anything was done on the platform: at most the app's identity was checked.
    expect(stub.calls.filter((call) => call.method !== "auth.test")).toEqual([]);
  });
});
