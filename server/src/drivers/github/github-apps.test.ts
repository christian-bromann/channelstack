/**
 * Exit check 12.3 for GitHub: several GitHub Apps on one org (decision 0027). Each has its own App
 * id, slug, `<slug>[bot]`, installation, private key and webhook secret, its own webhook URL, and
 * hears what the other Apps do on the repositories it is installed on, as GitHub sends it: one
 * delivery per App, signed for that App, with `sender.type: "Bot"` for another App's action. What
 * GitHub refuses one App's token, the fake refuses. Delivery cases A1 and A2 for GitHub use
 * `@octokit/webhooks` and Probot as the receivers.
 */
import { createPrivateKey } from "node:crypto";

import { Webhooks } from "@octokit/webhooks";
import { SignJWT } from "jose";
import { Probot } from "probot";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal, watchCredentials } from "../../../test/app-harness.ts";
import { webhookProblems } from "../../../test/schemas/github.ts";

const agents: RecordingAgent[] = [];
const checks: Array<() => void> = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
  for (const check of checks.splice(0)) check();
});

interface App {
  id: string;
  name: string;
  slug: string;
  botLogin: string;
  botUserId: string;
  appId: number;
  privateKey: string;
  webhookSecret: string;
}

/** What an App received: the event, its GUID and headers, the exact body and the parsed payload. */
const webhooks = (agent: RecordingAgent) =>
  agent.received.map(({ headers, body }) => ({
    event: String(headers["x-github-event"]),
    guid: String(headers["x-github-delivery"]),
    signature: String(headers["x-hub-signature-256"]),
    headers,
    body,
    payload: JSON.parse(body),
  }));

/**
 * An org with my-agent at one endpoint and `reviewer` at another, and a repository both are
 * installed on, with Ana on it. Every webhook either App gets holds to GitHub's schemas.
 */
async function twoApps() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  agents.push(mine, theirs);
  const h = harness(
    { github: mine.url },
    { appWebhooks: (driver, app) => (driver === "github" && app !== "unreachable" ? theirs.url : undefined) },
  );
  checks.push(() => {
    const issues = [...webhooks(mine), ...webhooks(theirs)].flatMap(({ event, payload }) =>
      webhookProblems(event, payload),
    );
    expect(issues.join("\n")).toBe("");
  });
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/github`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const app: App = (await get("")).app;
  const reviewer: App = await post("/apps", { name: "reviewer" });
  const ana = await post("/users", { login: "ana" });
  const repo = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id, reviewer.id] });
  const issue = await post(`/users/${ana.id}/issues`, { issue: { title: "Login fails" }, repo: repo.id });
  const issueRef = { repoId: repo.id, number: issue.number as number };
  await h.app.settled();
  // What each App has heard so far is its install and the issue: tests look at what comes after.
  mine.received.length = 0;
  theirs.received.length = 0;

  /** The JWT an App authenticates with, signed with its own private key. */
  const jwt = (of: App) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(String(of.appId))
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 540)
      .sign(createPrivateKey(of.privateKey));
  };
  /** Call the REST API as an App, by its JWT. */
  const asApp = async (of: App, method: string, path: string, body?: unknown) =>
    h.provider(method, `github${path}`, body, await jwt(of));
  /** An App's installation token, minted the way Octokit mints it. */
  const token = async (of: App) => {
    const installation = (await asApp(of, "GET", "/app/installations")).body[0].id;
    return (await asApp(of, "POST", `/app/installations/${installation}/access_tokens`)).body.token as string;
  };
  /** Call the REST API as an App's installation. */
  const api = async (of: App, method: string, path: string, body?: unknown) =>
    h.provider(method, `github${path}`, body, await token(of));
  const path = `/repos/acme/${repo.name}`;
  return { h, mine, theirs, base, post, get, app, reviewer, ana, repo, issueRef, jwt, asApp, token, api, path };
}

describe("exit check 12.3: GitHub Apps", () => {
  test("an App has its own App id, slug, bot, installation, key and webhook secret; the same name gives the same App", async () => {
    const { h, post, get, app, reviewer, repo } = await twoApps();
    expect(reviewer).toMatchObject({ name: "reviewer", kind: "app", slug: "reviewer", botLogin: "reviewer[bot]" });
    expect(String(reviewer.appId)).toMatch(/^[12]\d{6}$/);
    expect(reviewer.botUserId).toMatch(/^[12]\d{8}$/);
    expect(reviewer.webhookSecret).toMatch(/^[a-f0-9]{40}$/);
    for (const key of ["id", "appId", "botUserId", "privateKey", "webhookSecret"] as const) {
      expect(reviewer[key]).not.toBe(app[key]);
    }
    expect(reviewer.webhookSecret).toBe(h.secrets.forApp("github", "reviewer", "webhookSecret"));
    const installations = await Promise.all(
      [app, reviewer].map((one) => post(`/apps/${one.id}/installation-id`, { repo: repo.id })),
    );
    expect(installations[0]).toBe(await post("/installation-id", { repo: repo.id }));
    expect(installations[1]).not.toBe(installations[0]);
    expect(await post("/apps", { name: "reviewer" })).toEqual(reviewer);
    expect((await get("/apps")).map((one: App) => one.name)).toEqual(["my-agent", "reviewer"]);
    expect(await refusal(post("/apps", { name: "reviewer", events: ["push"] }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
  });

  test("each App's JWT and installation token answer as that App, and reach what its installation covers", async () => {
    const { asApp, api, token, app, reviewer, post, ana, path } = await twoApps();
    expect((await asApp(reviewer, "GET", "/app")).body).toMatchObject({ id: reviewer.appId, slug: "reviewer" });
    expect((await asApp(app, "GET", "/app")).body).toMatchObject({ id: app.appId, slug: "my-agent" });
    expect(await token(reviewer)).not.toBe(await token(app));
    // A JWT for another App's installation: GitHub's 404.
    const mineId = (await asApp(app, "GET", "/app/installations")).body[0].id;
    expect((await asApp(reviewer, "POST", `/app/installations/${mineId}/access_tokens`)).status).toBe(404);

    // A repository only my-agent is on doesn't exist for reviewer's token.
    const only = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });
    expect((await api(reviewer, "GET", `/repos/acme/${only.name}`)).status).toBe(404);
    expect((await api(app, "GET", `/repos/acme/${only.name}`)).status).toBe(200);
    expect((await api(reviewer, "GET", "/installation/repositories")).body.total_count).toBe(1);
    expect((await api(app, "GET", "/installation/repositories")).body.total_count).toBe(2);
    expect((await asApp(reviewer, "GET", `/repos/acme/${only.name}/installation`)).status).toBe(404);

    // An App without a permission is refused it with 403, as GitHub refuses an installation token.
    const reader = await post("/apps", { name: "reader", permissions: { issues: "read" } });
    await post(`/repos/${only.id}/install`, { app: reader.id });
    const issue = await post(`/users/${ana.id}/issues`, { issue: { title: "Hi" }, repo: only.id });
    const read = await api(reader, "GET", `/repos/acme/${only.name}/issues/${issue.number}`);
    expect(read.status).toBe(200);
    const write = await api(reader, "POST", `/repos/acme/${only.name}/issues/${issue.number}/comments`, { body: "x" });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ message: "Resource not accessible by integration" });
    expect((await api(reader, "GET", `${path}`)).status).toBe(404);
  });

  test("A1: a person's comment is one delivery per App, each with its own GUID, installation and target, signed for that App alone", async () => {
    const { h, mine, theirs, post, app, reviewer, ana, issueRef, get } = await twoApps();
    const comment = await post(`/users/${ana.id}/comment`, { body: "@reviewer have a look", issue: issueRef });
    await h.app.settled();

    const [to, other] = [webhooks(mine), webhooks(theirs)];
    expect(to.map((hook) => hook.event)).toEqual(["issue_comment"]);
    expect(other.map((hook) => hook.event)).toEqual(["issue_comment"]);
    const [own, theirsHook] = [to[0], other[0]];
    if (!own || !theirsHook) throw new Error("Both Apps were told");
    expect(own.guid).not.toBe(theirsHook.guid);
    const installations = await Promise.all(
      [app, reviewer].map((one) => post(`/apps/${one.id}/installation-id`, { repo: issueRef.repoId })),
    );
    expect(own.payload.installation.id).toBe(installations[0]);
    expect(theirsHook.payload.installation.id).toBe(installations[1]);
    expect(own.headers["x-github-hook-installation-target-id"]).toBe(String(app.appId));
    expect(theirsHook.headers["x-github-hook-installation-target-id"]).toBe(String(reviewer.appId));

    // Each App's own receiver takes its own delivery, and refuses the other App's.
    const receiver = (of: App) => new Webhooks({ secret: of.webhookSecret });
    const receive = (of: App, hook: typeof own) =>
      receiver(of).verifyAndReceive({
        id: hook.guid,
        name: "issue_comment",
        payload: hook.body,
        signature: hook.signature,
      });
    await expect(receive(app, own)).resolves.toBeUndefined();
    await expect(receive(reviewer, theirsHook)).resolves.toBeUndefined();
    await expect(receive(app, theirsHook)).rejects.toThrow();
    await expect(receive(reviewer, own)).rejects.toThrow();

    // The comment's delivery is my-agent's; every delivery says which App it went to.
    expect(comment.delivery).toMatchObject({ app: "my-agent", guid: own.guid });
    const listed = (await get("/deliveries")) as Array<{ app: string; guid: string }>;
    expect(listed.find((one) => one.guid === theirsHook.guid)?.app).toBe("reviewer");
    expect((await get(`/deliveries/${theirsHook.guid}`)).app).toBe("reviewer");
  });

  test("A2: another App's comment reaches the App with sender <slug>[bot] of type Bot, and its own comes back to it", async () => {
    const { h, mine, theirs, api, app, reviewer, path, issueRef } = await twoApps();
    const made = await api(reviewer, "POST", `${path}/issues/${issueRef.number}/comments`, { body: "LGTM" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      user: { login: "reviewer[bot]", type: "Bot" },
      performed_via_github_app: { slug: "reviewer", id: reviewer.appId },
    });
    await h.app.settled();

    const [heard] = webhooks(mine);
    expect(heard?.payload).toMatchObject({
      action: "created",
      comment: { body: "LGTM", user: { login: "reviewer[bot]", type: "Bot" } },
      sender: { login: "reviewer[bot]", type: "Bot", id: Number(reviewer.botUserId) },
    });
    // GitHub sends an App its own actions too: there is no GITHUB_TOKEN-style suppression for Apps.
    const [own] = webhooks(theirs);
    expect(own?.payload.sender).toMatchObject({ login: "reviewer[bot]", type: "Bot" });

    // Probot, as an agent built on it receives the delivery: the sender is a bot.
    if (!heard) throw new Error("my-agent was told");
    const probot = new Probot({
      appId: app.appId,
      privateKey: app.privateKey,
      secret: app.webhookSecret,
      logLevel: "fatal",
    });
    const seen: Array<{ isBot: boolean; sender: string }> = [];
    probot.on("issue_comment.created", (context) => {
      seen.push({ isBot: context.isBot, sender: context.payload.sender.login });
    });
    await probot.ready();
    await probot.webhooks.verifyAndReceive({
      id: heard.guid,
      name: "issue_comment",
      payload: heard.body,
      signature: heard.signature,
    });
    expect(seen).toEqual([{ isBot: true, sender: "reviewer[bot]" }]);
  });

  test("an App hears only the events it subscribed to, on repositories it is installed on, at its own URL", async () => {
    const { h, theirs, post, ana, issueRef, app } = await twoApps();
    const pusher = await post("/apps", { name: "pusher", events: ["push"] });
    const unreachable = await post("/apps", { name: "unreachable" });
    for (const one of [pusher, unreachable]) await post(`/repos/${issueRef.repoId}/install`, { app: one.id });
    const elsewhere = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });
    await h.app.settled();
    theirs.received.length = 0;

    await post(`/users/${ana.id}/comment`, { body: "hi", issue: issueRef });
    const other = await post(`/users/${ana.id}/issues`, { issue: { title: "Elsewhere" }, repo: elsewhere.id });
    await post(`/users/${ana.id}/comment`, { body: "hi", issue: { repoId: elsewhere.id, number: other.number } });
    await h.app.settled();

    // reviewer and pusher share an endpoint here: only reviewer subscribed to issue_comment, and
    // neither is on the other repository.
    const heard = webhooks(theirs);
    expect(heard.map((hook) => [hook.event, hook.headers["x-github-hook-installation-target-id"]])).toEqual([
      ["issue_comment", expect.any(String)],
    ]);
    expect(heard[0]?.headers["x-github-hook-installation-target-id"]).not.toBe(String(pusher.appId));
    expect(heard.some((hook) => hook.payload.repository.id === Number(elsewhere.id))).toBe(false);
  });

  test("installing an App on a repository tells that App alone, with its own installation", async () => {
    const { h, mine, theirs, post, app, reviewer, ana } = await twoApps();
    const repo = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });
    await h.app.settled();
    expect(webhooks(theirs)).toEqual([]);
    mine.received.length = 0;

    const added = await post(`/repos/${repo.id}/install`, { app: reviewer.id });
    await h.app.settled();
    expect(added).toMatchObject({ app: "reviewer", type: "installation_repositories", action: "added" });
    expect(webhooks(mine)).toEqual([]);
    const [told] = webhooks(theirs);
    expect(told?.payload).toMatchObject({
      action: "added",
      installation: { app_id: reviewer.appId, app_slug: "reviewer" },
      repositories_added: [{ name: repo.name }],
      sender: { login: "acme", type: "Organization" },
    });
    expect(await refusal(post(`/repos/${repo.id}/install`, { app: reviewer.id }))).toBe("validation_failed");
    expect((await post(`/repos/${repo.id}/uninstall`, { app: reviewer.id })).app).toBe("reviewer");
    await h.app.settled();
    expect(webhooks(mine)).toEqual([]);
  });

  test("check_run created and completed go to every subscribed App; rerequested and requested_action to the App that made the run alone", async () => {
    const { h, mine, theirs, api, post, reviewer, path, ana } = await twoApps();
    const sha = (await api(reviewer, "GET", `${path}/commits/main`)).body.sha;
    const made = await api(reviewer, "POST", `${path}/check-runs`, {
      name: "review",
      head_sha: sha,
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review", summary: "Looks fine" },
      actions: [{ label: "Fix", description: "Apply the fix", identifier: "fix" }],
    });
    expect(made.status).toBe(201);
    expect(made.body.app).toMatchObject({ slug: "reviewer", id: reviewer.appId });
    await h.app.settled();
    for (const agent of [mine, theirs]) {
      expect(webhooks(agent).map((hook) => `${hook.event}.${hook.payload.action}`)).toEqual([
        "check_run.created",
        "check_run.completed",
      ]);
      agent.received.length = 0;
    }

    const rerun = await post(`/users/${ana.id}/rerun`, { checkRun: made.body.id });
    const clicked = await post(`/users/${ana.id}/request-action`, { identifier: "fix", checkRun: made.body.id });
    await h.app.settled();
    expect(rerun).toMatchObject({ app: "reviewer", action: "rerequested" });
    expect(clicked).toMatchObject({ app: "reviewer", action: "requested_action" });
    expect(webhooks(mine)).toEqual([]);
    expect(webhooks(theirs).map((hook) => hook.payload.action)).toEqual(["rerequested", "requested_action"]);
  });

  test("a scripted App comments, opens issues and reviews as its own calls would, where its installation may; never as my-agent", async () => {
    const { h, mine, post, app, reviewer, ana, issueRef } = await twoApps();
    const comment = await post(`/apps/${reviewer.id}/comment`, { body: "@my-agent over to you", issue: issueRef });
    const opened = await post(`/apps/${reviewer.id}/issues`, { issue: { title: "Follow-up" }, repo: issueRef.repoId });
    const pr = await post(`/users/${ana.id}/pulls`, {
      pr: { from: "fix", title: "Fix", changes: [{ path: "a.ts", content: Buffer.from("x\n").toString("base64") }] },
      repo: issueRef.repoId,
    });
    const review = await post(`/apps/${reviewer.id}/review`, {
      review: { pr: { repoId: issueRef.repoId, number: pr.number }, event: "APPROVE", body: "Ship it" },
    });
    await h.app.settled();

    expect(comment.author).toMatchObject({ kind: "app", name: "reviewer", botLogin: "reviewer[bot]" });
    expect(opened.author).toMatchObject({ kind: "app", name: "reviewer" });
    expect(review).toMatchObject({ state: "APPROVED", author: { kind: "app", name: "reviewer" } });
    const told = webhooks(mine).filter((hook) => hook.payload.sender.login === "reviewer[bot]");
    expect(told.map((hook) => `${hook.event}.${hook.payload.action}`)).toEqual([
      "issue_comment.created",
      "issues.opened",
      "pull_request_review.submitted",
    ]);
    expect(told[0]?.payload.comment.performed_via_github_app).toMatchObject({ slug: "reviewer" });

    // Acting as my-agent is the agent's own business, and an App reaches only what its installation covers.
    expect(await refusal(post(`/apps/${app.id}/comment`, { body: "hi", issue: issueRef }))).toBe("invalid_argument");
    const elsewhere = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });
    const there = await post(`/users/${ana.id}/issues`, { issue: { title: "There" }, repo: elsewhere.id });
    expect(
      await refusal(
        post(`/apps/${reviewer.id}/comment`, { body: "hi", issue: { repoId: elsewhere.id, number: there.number } }),
      ),
    ).toBe("not_found");
    const reader = await post("/apps", { name: "reader", permissions: { issues: "read" } });
    await post(`/repos/${issueRef.repoId}/install`, { app: reader.id });
    expect(await refusal(post(`/apps/${reader.id}/comment`, { body: "hi", issue: issueRef }))).toBe("forbidden");
  });

  test("an App subscribes only to the events its permissions cover, and hears only those", async () => {
    const { h, theirs, post, ana, issueRef, reviewer } = await twoApps();
    const reader = await post("/apps", { name: "reader", permissions: { issues: "read" } });
    expect(reader).toMatchObject({ name: "reader" });
    expect(await refusal(post("/apps", { name: "pusher", permissions: { issues: "read" }, events: ["push"] }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(post("/apps", { name: "watcher", events: ["star"] }))).toBe("invalid_argument");
    await post(`/repos/${issueRef.repoId}/install`, { app: reader.id });
    await h.app.settled();
    theirs.received.length = 0;

    await post(`/users/${ana.id}/comment`, { body: "hi", issue: issueRef });
    await post(`/users/${ana.id}/push`, {
      changes: [{ path: "a.txt", content: Buffer.from("a\n").toString("base64") }],
      repo: issueRef.repoId,
      branch: "main",
    });
    await h.app.settled();
    // reader and reviewer share an endpoint here: reader's are the ones for its App id.
    const heard = (of: App) =>
      webhooks(theirs)
        .filter((hook) => hook.headers["x-github-hook-installation-target-id"] === String(of.appId))
        .map((hook) => hook.event);
    expect(heard(reader)).toEqual(["issue_comment"]);
    expect(heard(reviewer)).toEqual(["issue_comment", "push"]);
  });

  test("check_suite requested goes to each App with checks write that subscribes to it, alone, for the pushed head", async () => {
    const { h, mine, theirs, post, ana, issueRef, api, path } = await twoApps();
    const ci = await post("/apps", {
      name: "ci",
      permissions: { checks: "write", contents: "read" },
      events: ["check_suite", "check_run"],
    });
    const lint = await post("/apps", { name: "lint", permissions: { checks: "read" }, events: ["check_suite"] });
    for (const one of [ci, lint]) await post(`/repos/${issueRef.repoId}/install`, { app: one.id });
    await h.app.settled();
    mine.received.length = 0;
    theirs.received.length = 0;

    const commit = await post(`/users/${ana.id}/push`, {
      changes: [{ path: "a.txt", content: Buffer.from("a\n").toString("base64") }],
      repo: issueRef.repoId,
      branch: "main",
      message: "Add a",
    });
    await h.app.settled();
    const suites = webhooks(theirs).filter((hook) => hook.event === "check_suite");
    // ci alone: lint may only read checks, and my-agent and reviewer don't subscribe to check_suite.
    expect(suites.map((hook) => hook.headers["x-github-hook-installation-target-id"])).toEqual([String(ci.appId)]);
    expect(suites[0]?.payload).toMatchObject({
      action: "requested",
      check_suite: {
        head_sha: commit.sha,
        head_branch: "main",
        status: "queued",
        app: { id: ci.appId, slug: "ci" },
        head_commit: { id: commit.sha, message: "Add a" },
      },
      installation: { id: expect.any(Number) },
      sender: { login: "ana" },
    });
    expect(webhooks(mine).some((hook) => hook.event === "check_suite")).toBe(false);

    // The run ci makes for that commit is in the suite it was asked for.
    const run = await api(ci, "POST", `${path}/check-runs`, { name: "build", head_sha: commit.sha });
    expect(run.body.check_suite.id).toBe(suites[0]?.payload.check_suite.id);
  });

  test("an App's private key and webhook secret come with its handle only: no author or principal holds them", async () => {
    const { h, base, post, get, app, reviewer, ana, issueRef, api, path } = await twoApps();
    const watch = watchCredentials(h, "github");
    const comment = await post(`/apps/${reviewer.id}/comment`, { body: "@my-agent over to you", issue: issueRef });
    await post(`/apps/${reviewer.id}/issues`, { issue: { title: "Follow-up" }, repo: issueRef.repoId });
    await post(`/apps/${reviewer.id}/react`, { content: "+1", comment: comment.id });
    await post(`/users/${ana.id}/assign`, { assignees: [app.id], issue: issueRef });
    const pr = await post(`/users/${ana.id}/pulls`, {
      pr: { from: "fix", title: "Fix", changes: [{ path: "a.ts", content: Buffer.from("x\n").toString("base64") }] },
      repo: issueRef.repoId,
    });
    const prRef = `/repos/${issueRef.repoId}/pulls/${pr.number}`;
    await post(`/apps/${reviewer.id}/review`, {
      review: { pr: { repoId: issueRef.repoId, number: pr.number }, event: "COMMENT", body: "Looks fine" },
    });
    const sha = (await api(reviewer, "GET", `${path}/commits/fix`)).body.sha;
    await api(reviewer, "POST", `${path}/statuses/${sha}`, { state: "success", context: "review" });
    await api(reviewer, "POST", `${path}/check-runs`, {
      name: "review",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    });
    await h.app.settled();
    const issue = `/repos/${issueRef.repoId}/issues/${issueRef.number}`;
    const reads = [
      ...["", "/comments", "/assignees", "/transcript"].map((read) => `${issue}${read}`),
      ...["", "/reviews", "/check-runs", "/review-comments"].map((read) => `${prRef}${read}`),
      `/comments/${comment.id}/reactions`,
      `/repos/${issueRef.repoId}/commits/${sha}/statuses`,
      `/repos/${issueRef.repoId}/commits/${sha}/check-runs`,
      "/deliveries",
    ];
    for (const read of reads) expect([read, (await h.call("GET", `${base}${read}`)).status]).toEqual([read, 200]);
    // The handle routes still carry the credentials: an agent's tests read them there.
    expect((await get("/apps")).map((one: App) => one.privateKey)).toEqual([app.privateKey, reviewer.privateKey]);

    const secrets = [app, reviewer].flatMap((one) => [one.privateKey, one.webhookSecret]);
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);
    expect(watch.leaks([...secrets, "PRIVATE KEY-----"])).toEqual([]);
  });

  test("a person and an App of one session can't share a name", async () => {
    const { post } = await twoApps();
    expect(await refusal(post("/users", { login: "reviewer" }))).toBe("invalid_argument");
    await post("/users", { login: "ben" });
    expect(await refusal(post("/apps", { name: "ben" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the App's lines under my-agent's keys", async () => {
    const { h, reviewer } = await twoApps();
    const env = (await h.call("GET", "/env?app=reviewer&channel=github")).body;
    expect(env).toMatchObject({
      GITHUB_APP_ID: String(reviewer.appId),
      GITHUB_APP_SLUG: "reviewer",
      GITHUB_BOT_USER_ID: reviewer.botUserId,
      GITHUB_PRIVATE_KEY: reviewer.privateKey.replaceAll("\n", "\\n"),
      GITHUB_WEBHOOK_SECRET: reviewer.webhookSecret,
    });
    expect(env.GITHUB_INSTALLATION_ID).toMatch(/^[6-9]\d{7}$/);
    expect((await h.call("GET", "/env?app=my-agent&channel=github")).body.GITHUB_WEBHOOK_SECRET).toBe(
      h.secrets.get("github", "webhookSecret"),
    );
    // An App no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=linter&channel=github")).body.GITHUB_WEBHOOK_SECRET).toBe(
      h.secrets.forApp("github", "linter", "webhookSecret"),
    );
  });
});
