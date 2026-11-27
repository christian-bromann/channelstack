import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { harness } from "./app-harness.ts";
import { githubStub } from "./github-live-stub.ts";
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
  "`channelstack.reset()`": { channel: "", method: "POST", path: "/reset", reason: /never wiped/ },
  // Decision 0027: another app is built in the fake; live, each needs a sandbox app of its own (#111).
  "Several apps: `slack.createApp({ name })`, `apps()`, a scripted app's `say` / `reply` / `react`, `msg.deliveryFor(app)`":
    { channel: "slack", method: "POST", path: "/apps", body: { name: "coder" } },
  "Several Apps: `github.createApp({ name })`, `apps()`, `createRepo({ apps })`, `repo.installApp(app)`, a scripted App's comments, issues and reviews":
    { channel: "github", method: "POST", path: "/apps", body: { name: "coder" } },
  "Several apps: `linear.createApp({ name })`, `apps()`, delegating or mentioning one, a scripted app's `comment` / `reply`, `comment.deliveryFor(app)`":
    { channel: "linear", method: "POST", path: "/apps", body: { name: "coder" } },
  "Several integrations: `notion.createApp({ name })`, `apps()`, `connections: [notion.app, writer]`, a scripted integration's `comment` / `reply` / `edit` / `rename`":
    { channel: "notion", method: "POST", path: "/apps", body: { name: "coder" } },
  "Several apps: `resend.createApp({ name, domain })`, `apps()`, a scripted app's `send` / `reply` with its headers, `email.deliveryFor(app)`":
    { channel: "resend", method: "POST", path: "/apps", body: { name: "coder" } },
  "Several apps: `google.createApp({ name })`, `apps()`, a scripted app's `send` / `reply` with its headers, `email.deliveryFor(app)`":
    { channel: "google", method: "POST", path: "/apps", body: { name: "coder" } },
  "`slack.createChannel({ shared: true })` (Slack Connect)": {
    channel: "slack",
    method: "POST",
    path: "/channels",
    body: { shared: true, participants: [] },
    reason: /Slack Connect/,
  },
  "`ana.say(text, { channel, files })`, `ana.reply(text, { thread, files })`": [
    {
      channel: "slack",
      method: "POST",
      path: "/users/U0X/say",
      body: { message: { text: "the log" }, channel: "C0X", files: [{ path: "a.log", content: "" }] },
      reason: /attach files/,
    },
    {
      channel: "slack",
      method: "POST",
      path: "/users/U0X/reply",
      body: { message: {}, thread: { channel: "C0X", ts: "1.2" }, files: [{ path: "a.log", content: "" }] },
      reason: /attach files/,
    },
  ],
  "`slack.uninstallApp()`": { channel: "slack", method: "POST", path: "/uninstall", reason: /OAuth consent/ },
  '`delivery.retry({ after: "3s" })`': { channel: "slack", method: "POST", path: "/deliveries/E0X/retry", body: {} },
  // The App's bot as an assignee is refused before anything else (the stub's App has id 1).
  "`ana.assign(github.app, { issue })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/assign",
    body: { assignees: ["1"], issue: { repoId: "1", number: 1 } },
    reason: /App's bot/,
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
    { channel: "resend", method: "POST", path: "/deliveries/x/resend", body: {} },
    { channel: "resend", method: "POST", path: "/deliveries/x/redeliver", reason: /no API to redeliver/ },
    { channel: "google", method: "POST", path: "/deliveries/x/resend", body: {} },
    { channel: "google", method: "POST", path: "/deliveries/x/redeliver", reason: /no API to push/ },
  ],
  "`notion.setContentUpdateDelay(delay)`": {
    channel: "notion",
    method: "POST",
    path: "/content-delay",
    body: { delay: 0 },
    reason: /batches/,
  },
  "`notion.sendVerification()`": { channel: "notion", method: "POST", path: "/verification", reason: /verification/ },
  "`repo.installApp` / `uninstallApp`": [
    { channel: "github", method: "POST", path: "/repos/1/install", body: { app: "1" } },
    { channel: "github", method: "POST", path: "/repos/1/uninstall", body: { app: "1" } },
  ],
  "`ana.push(changes, { repo, branch })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/push",
    body: { changes: [{ path: "a", content: "YQ==" }], repo: "1", branch: "b" },
  },
  "`ana.openPullRequest`": {
    channel: "github",
    method: "POST",
    path: "/users/1/pulls",
    body: { pr: { from: "b" }, repo: "1" },
  },
  "`ana.minimize({ comment })`": { channel: "github", method: "POST", path: "/users/1/minimize", body: { comment: 1 } },
  "`ana.review({ pr, event, comments })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/review",
    body: { review: { pr: { repoId: "1", number: 1 }, event: "APPROVE" } },
  },
  "`ana.reviewComment(text, { pr, path, line })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/review-comment",
    body: { body: "x", pr: { repoId: "1", number: 1 }, path: "a", line: 1 },
  },
  "`ana.reply(text, { comment })` (review thread)": {
    channel: "github",
    method: "POST",
    path: "/users/1/reply",
    body: { body: "x", comment: 1 },
  },
  "`ana.resolve` / `unresolve`": [
    { channel: "github", method: "POST", path: "/users/1/resolve", body: { comment: 1 } },
    { channel: "github", method: "POST", path: "/users/1/unresolve", body: { comment: 1 } },
  ],
  "`ana.requestReview([ben], { pr })`": {
    channel: "github",
    method: "POST",
    path: "/users/1/request-review",
    body: { reviewers: ["2"], pr: { repoId: "1", number: 1 } },
  },
  "`ana.markReady({ pr })` / `merge({ pr })`": [
    { channel: "github", method: "POST", path: "/users/1/mark-ready", body: { pr: { repoId: "1", number: 1 } } },
    { channel: "github", method: "POST", path: "/users/1/merge", body: { pr: { repoId: "1", number: 1 } } },
  ],
  "`pr.checkRuns()`, `commit.statuses()`, `toHaveCheckRun`": [
    { channel: "github", method: "GET", path: "/repos/1/pulls/1/check-runs" },
    { channel: "github", method: "GET", path: "/repos/1/commits/abc/check-runs" },
    { channel: "github", method: "GET", path: "/repos/1/commits/abc/statuses" },
  ],
  "`pr.reviews()`, `reviewComments()`, `toHaveReviewComment`, `toBeMerged`, `comment.reactions()`": [
    { channel: "github", method: "GET", path: "/repos/1/pulls/1/reviews" },
    { channel: "github", method: "GET", path: "/repos/1/pulls/1/review-comments" },
    { channel: "github", method: "GET", path: "/repos/1/pulls/1/merged" },
    { channel: "github", method: "GET", path: "/comments/1/reactions" },
  ],
  "`notion.createDatabase({ properties, rows })`": {
    channel: "notion",
    method: "POST",
    path: "/databases",
    body: { title: "Tasks", properties: { Name: "title" } },
    reason: /databases/,
  },
  "`ana.setProperty`, `addRow`": [
    {
      channel: "notion",
      method: "POST",
      path: "/users/x/set-property",
      body: { name: "Status", value: "Done", page: "p" },
      reason: /databases/,
    },
    {
      channel: "notion",
      method: "POST",
      path: "/users/x/rows",
      body: { values: {}, database: "d" },
      reason: /databases/,
    },
  ],
  "`page.property()`, `database.rows()`, `toHavePropertyValue`": [
    { channel: "notion", method: "GET", path: "/pages/p/property?name=Status", reason: /databases/ },
    { channel: "notion", method: "POST", path: "/databases/d/rows", body: {}, reason: /databases/ },
  ],
  "`ana.say(text, { to: discord.app })`, `openDM(discord.app)`": {
    channel: "discord",
    method: "POST",
    path: "/users/x/open-dm",
    body: { participant: "a" },
    reason: /DM/,
  },
  '`ana.runCommand("/deploy web", { channel })`, `ana.click(label, …)`': [
    { channel: "discord", method: "POST", path: "/users/x/commands", body: { command: "/deploy", channel: "c" } },
    { channel: "discord", method: "POST", path: "/users/x/click", body: { button: { label: "Go" }, channel: "c" } },
  ],
  '`discord.fault({ type: "rate_limit" })`, `{ type: "drop_gateway" }`': [
    { channel: "discord", method: "POST", path: "/faults", body: { type: "rate_limit" } },
    { channel: "discord", method: "POST", path: "/faults", body: { type: "drop_gateway" } },
    { channel: "discord", method: "DELETE", path: "/faults/1" },
  ],
  "`discord.verifyEndpoint()`": { channel: "discord", method: "POST", path: "/verify-endpoint", reason: /portal/ },
  "`delivery.resend({ badSignature })`, `redeliver()`": [
    { channel: "discord", method: "POST", path: "/deliveries/x/resend", body: { badSignature: true } },
    { channel: "discord", method: "POST", path: "/deliveries/x/redeliver" },
  ],
};

/** Every driver live: Slack and GitHub against their stubs, Linear and Notion with stand-in credentials. */
function liveEverywhere() {
  const stub = slackStub();
  const github = githubStub();
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(github.url)
      ? github.fetch(input, init)
      : stub.fetch(input, init)) as typeof globalThis.fetch;
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_SLACK_APP_ID: "A0STUBAPP1",
          CHANNELSTACK_SLACK_BOT_TOKEN: stub.bot.token,
          CHANNELSTACK_LIVE_SLACK_TEAMS: stub.team,
          CHANNELSTACK_GITHUB_APP_ID: String(github.app.id),
          CHANNELSTACK_GITHUB_PRIVATE_KEY: github.privateKey,
          CHANNELSTACK_LIVE_GITHUB_ORGS: github.org,
          CHANNELSTACK_LINEAR_APP_TOKEN: "not-a-token",
          CHANNELSTACK_NOTION_TOKEN: "not-a-token",
          CHANNELSTACK_RESEND_API_KEY: "not-a-token",
          CHANNELSTACK_GOOGLE_CLIENT_ID: "not-a-client",
          CHANNELSTACK_GOOGLE_CLIENT_SECRET: "not-a-secret",
          CHANNELSTACK_GOOGLE_REFRESH_TOKEN: "not-a-token",
          CHANNELSTACK_DISCORD_BOT_TOKEN: "not-a-token",
        },
        fetch,
        apiBase: { slack: stub.apiBase, github: github.url },
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
