import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { refusal } from "../../../test/app-harness.ts";
import { githubWorkspace } from "../../../test/github-workspace.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function workspace(options?: Parameters<typeof githubWorkspace>[0]) {
  const space = await githubWorkspace(options);
  closers.push(() => {
    space.agent.close();
    // Whatever a test is about, every answer and every webhook in it is what GitHub's schemas describe.
    expect(space.problems.join("\n")).toBe("");
    expect(space.webhookIssues().join("\n")).toBe("");
  });
  /** Open an issue as Ana, and the handle fields a later call names it by. */
  const issue = async (title = "Something") => {
    const opened = await space.post(`/users/${space.ana.id}/issues`, { issue: { title }, repo: space.repo.id });
    return { ...opened, ref: { repoId: space.repo.id, number: opened.number as number } };
  };
  /** Open a pull request as Ana that changes one file. */
  const pull = async (content = "export const x = 1\n", extra: object = {}) => {
    const opened = await space.post(`/users/${space.ana.id}/pulls`, {
      pr: { from: "feat", title: "Add app", changes: [{ path: "src/app.ts", content: b64(content) }], ...extra },
      repo: space.repo.id,
    });
    return { ...opened, ref: { repoId: space.repo.id, number: opened.number as number } };
  };
  return { ...space, issue, pull };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("authentication", () => {
  test("the App's endpoints take its JWT, and nothing else", async () => {
    const { app, asApp, raw, jwt, token } = await workspace();
    expect((await asApp("GET", "/app")).body).toMatchObject({ id: app.appId, slug: "my-agent" });
    expect((await raw("GET", "/app")).status).toBe(401);
    expect((await raw("GET", "/app", "Bearer not-a-jwt")).status).toBe(401);
    // An installation token is not the App.
    expect((await raw("GET", "/app", `Bearer ${await token()}`)).status).toBe(401);
    // Another App's id, and a JWT that is good for longer than GitHub allows.
    expect((await raw("GET", "/app", `Bearer ${await jwt({ iss: "1" })}`)).status).toBe(401);
    expect((await raw("GET", "/app", `Bearer ${await jwt({ expiresIn: 3600 })}`)).status).toBe(401);
    expect(await (await raw("GET", "/app", "Bearer not-a-jwt")).json()).toMatchObject({
      message: "A JSON web token could not be decoded",
      documentation_url: expect.any(String),
    });
  });

  test("everything else takes the installation token, as `token` or `Bearer`", async () => {
    const { raw, jwt, path, token } = await workspace();
    const installation = await token();
    expect(installation).toMatch(/^ghs_[A-Za-z0-9]{36}$/);
    expect((await raw("GET", path, `token ${installation}`)).status).toBe(200);
    expect((await raw("GET", path, `Bearer ${installation}`)).status).toBe(200);
    expect((await raw("GET", path)).status).toBe(401);
    expect((await raw("GET", path, "token ghs_wrong")).status).toBe(401);
    // The App's JWT doesn't reach a repository: it has to be exchanged for a token first.
    expect((await raw("GET", path, `Bearer ${await jwt()}`)).status).toBe(401);
    // An installation is not a user.
    expect((await raw("GET", "/user", `token ${installation}`)).status).toBe(403);
  });

  test("the same API answers under /api/v3, where SDKs given a host expect it", async () => {
    const { raw, path, token, asApp } = await workspace();
    const response = await raw("GET", `/api/v3${path}`, `token ${await token()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-github-media-type")).toBe("github.v3; format=json");
    expect((await asApp("GET", "/api/v3/app")).status).toBe(200);
    expect((await raw("GET", "/api/v3/nope", `token ${await token()}`)).status).toBe(404);
  });

  test("the token is refused for another installation, and minted for the App's own", async () => {
    const { asApp, app, repo, post } = await workspace();
    const id = await post("/installation-id", { repo: repo.id });
    expect((await asApp("POST", "/app/installations/1/access_tokens")).status).toBe(404);
    const minted = await asApp("POST", `/app/installations/${id}/access_tokens`);
    expect(minted.status).toBe(201);
    expect(Date.parse(minted.body.expires_at)).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    expect((await asApp("GET", `/repos/acme/${repo.name}/installation`)).body).toMatchObject({ id, app_id: app.appId });
  });
});

describe("installation", () => {
  test("no install, no events and no access; installing sends installation_repositories", async () => {
    const { h, ana, post, api, webhooks, app } = await workspace();
    const quiet = await post("/repos", { collaborators: [{ user: ana.id }] });
    const issue = await post(`/users/${ana.id}/issues`, { issue: { title: "Hello?" }, repo: quiet.id });
    const comment = await post(`/users/${ana.id}/comment`, {
      body: "@my-agent ping",
      issue: { repoId: quiet.id, number: issue.number },
    });
    await h.app.settled();
    expect(comment.delivery).toBeUndefined();
    expect(webhooks().filter((hook) => hook.payload.repository?.name === quiet.name)).toEqual([]);
    // For the App's token the repository isn't there.
    expect((await api("GET", `/repos/acme/${quiet.name}`)).status).toBe(404);
    expect(await refusal(post("/installation-id", { repo: quiet.id }))).toBe("not_found");

    const installed = await post(`/repos/${quiet.id}/install`, { app: app.id });
    await h.app.settled();
    expect(installed).toMatchObject({ type: "installation_repositories", action: "added" });
    expect(webhooks().at(-1)?.payload).toMatchObject({
      action: "added",
      repositories_added: [{ name: quiet.name, full_name: `acme/${quiet.name}` }],
      repository_selection: "selected",
    });
    expect(await refusal(post(`/repos/${quiet.id}/install`, { app: app.id }))).toBe("validation_failed");
    expect((await post(`/repos/${quiet.id}/uninstall`, { app: app.id })).action).toBe("removed");
  });

  test("the App reaches a repository only while it is installed there", async () => {
    const { ana, post, raw, token, app } = await workspace();
    const other = await post("/repos", { collaborators: [{ user: ana.id }] });
    const auth = `token ${await token()}`;
    expect((await raw("GET", `/repos/acme/${other.name}`, auth)).status).toBe(404);
    await post(`/repos/${other.id}/install`, { app: app.id });
    expect((await raw("GET", `/repos/acme/${other.name}`, auth)).status).toBe(200);
    const listed = (await (await raw("GET", "/installation/repositories", auth)).json()) as { total_count: number };
    expect(listed.total_count).toBe(2);
  });
});

describe("webhooks", () => {
  test("a delivery carries GitHub's headers and a signature over the exact bytes", async () => {
    const { h, app, ana, issue, post, webhooks } = await workspace();
    const { ref } = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "@my-agent hi", issue: ref });
    await h.app.settled();
    const hook = webhooks().find((candidate) => candidate.event === "issue_comment");
    if (!hook) throw new Error("No issue_comment arrived");
    expect(hook.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hook.guid).toBe(comment.delivery.guid);
    expect(hook.headers).toMatchObject({
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": String(app.appId),
      "content-type": "application/json",
    });
    const signed = (algorithm: string) => createHmac(algorithm, app.webhookSecret).update(hook.body).digest("hex");
    expect(hook.headers["x-hub-signature-256"]).toBe(`sha256=${signed("sha256")}`);
    expect(hook.headers["x-hub-signature"]).toBe(`sha1=${signed("sha1")}`);
    expect(hook.payload).toMatchObject({
      action: "created",
      comment: { body: "@my-agent hi", user: { login: "ana", type: "User" } },
      sender: { login: "ana" },
      installation: { id: expect.any(Number) },
      organization: { login: "acme" },
    });
  });

  test("redelivery is the same GUID again, and the App's delivery log shows both", async () => {
    const { h, agent, ana, issue, post, get, asApp } = await workspace();
    const { ref } = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "@my-agent hi", issue: ref });
    await h.app.settled();
    const received = agent.received.length;

    const attempt = await post(`/deliveries/${comment.delivery.id}/redeliver`);
    await h.app.settled();
    expect(attempt).toMatchObject({ number: 2, forgedSignature: false });
    expect(agent.received).toHaveLength(received + 1);
    expect(agent.received.at(-1)?.headers["x-github-delivery"]).toBe(comment.delivery.guid);

    const log = (await asApp("GET", "/app/hook/deliveries")).body.filter(
      (entry: { guid: string }) => entry.guid === comment.delivery.guid,
    );
    expect(log.map((entry: { redelivery: boolean }) => entry.redelivery).sort()).toEqual([false, true]);
    expect(log[0]).toMatchObject({ event: "issue_comment", action: "created", status: "OK", status_code: 200 });
    const detail = (await asApp("GET", `/app/hook/deliveries/${log[0].id}`)).body;
    expect(detail.request.payload).toMatchObject({ action: "created" });

    // The App can ask for a redelivery itself, as Probot's and GitHub's own tooling do.
    expect((await asApp("POST", `/app/hook/deliveries/${log[0].id}/attempts`)).status).toBe(202);
    await h.app.settled();
    expect((await get(`/deliveries/${comment.delivery.id}`)).attempts).toHaveLength(3);
    expect((await asApp("GET", "/app/hook/deliveries/1")).status).toBe(404);
  });

  test("a forged delivery is signed with a secret that isn't the App's", async () => {
    const { h, app, agent, ana, issue, post } = await workspace();
    const { ref } = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "@my-agent hi", issue: ref });
    await h.app.settled();
    expect(await post(`/deliveries/${comment.delivery.id}/resend`, { badSignature: true })).toMatchObject({
      forgedSignature: true,
    });
    await h.app.settled();
    const forged = agent.received.at(-1);
    const real = createHmac("sha256", app.webhookSecret)
      .update(forged?.body ?? "")
      .digest("hex");
    expect(forged?.headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(forged?.headers["x-hub-signature-256"]).not.toBe(`sha256=${real}`);
  });

  test("without a webhook URL nothing is sent, and actions still work", async () => {
    const { ana, issue, post, get } = await workspace({ reachable: false });
    const { ref } = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "@my-agent hi", issue: ref });
    expect(comment.delivery).toBeUndefined();
    expect(await post(`/users/${ana.id}/close`, { issue: ref })).toBeNull();
    expect(await get("/deliveries")).toEqual([]);
  });
});

describe("what people may do", () => {
  test("permissions follow the org role and the repository's collaborators", async () => {
    const { ana, app, repo, issue, post } = await workspace();
    const { ref } = await issue();
    const member = await post("/users", { login: "mel" });
    const outsider = await post("/users", { login: "olaf", role: "outside_collaborator" });
    const admin = await post("/users", { login: "ada", role: "admin" });
    const change = { changes: [{ path: "a.txt", content: b64("a") }], repo: repo.id, branch: "x" };

    // An org member reads every repository of the org: they may comment, not push or label.
    expect((await post(`/users/${member.id}/comment`, { body: "hi", issue: ref })).body).toBe("hi");
    expect(await refusal(post(`/users/${member.id}/push`, change))).toBe("forbidden");
    expect(await refusal(post(`/users/${member.id}/label`, { labels: ["bug"], issue: ref }))).toBe("forbidden");
    expect(await refusal(post(`/users/${member.id}/close`, { issue: ref }))).toBe("forbidden");
    // Someone outside the org doesn't see a private repository at all.
    expect(await refusal(post(`/users/${outsider.id}/comment`, { body: "hi", issue: ref }))).toBe("not_found");
    // An org admin may do everything; the author may close their own issue.
    expect((await post(`/users/${admin.id}/push`, change)).message).toBe("Update a.txt");
    expect((await post(`/users/${ana.id}/close`, { issue: ref })).action).toBe("closed");
    // The App's bot can be assigned, as the contract has it.
    const assigned = await post(`/users/${ana.id}/assign`, { assignees: [app.id, member.id], issue: ref });
    expect(
      assigned.map((delivery: { payload: { assignee: { login: string } } }) => delivery.payload.assignee.login),
    ).toEqual(["my-agent[bot]", "mel"]);
    // A label a person picks has to exist.
    expect(await refusal(post(`/users/${ana.id}/label`, { labels: ["nope"], issue: ref }))).toBe("not_found");
  });

  test("a comment is its author's to edit; deleting someone else's needs write access", async () => {
    const { ana, issue, post, get } = await workspace();
    const { ref } = await issue();
    const member = await post("/users", { login: "mel" });
    const comment = await post(`/users/${ana.id}/comment`, { body: "first", issue: ref });
    expect(await refusal(post(`/users/${member.id}/edit`, { body: "hacked", comment: comment.id }))).toBe("forbidden");
    expect((await post(`/users/${ana.id}/edit`, { body: "second", comment: comment.id })).action).toBe("edited");
    expect((await get(`/comments/${comment.id}`)).body).toBe("second");
    await post(`/users/${member.id}/react`, { content: "heart", comment: comment.id });
    expect(await get(`/comments/${comment.id}/reactions`)).toMatchObject([
      { content: "heart", by: [{ login: "mel" }] },
    ]);
    expect((await post(`/users/${ana.id}/delete`, { comment: comment.id })).action).toBe("deleted");
    expect(await get(`/repos/${ref.repoId}/issues/${ref.number}/comments`)).toEqual([]);
    expect(await refusal(post(`/users/${ana.id}/react`, { content: "heart" }))).toBe("invalid_argument");
  });

  test("a deleted comment is gone: it can't be edited, deleted again, reacted to or read", async () => {
    const { h, ana, issue, pull, post, get, webhooks } = await workspace();
    const { ref } = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "oops", issue: ref });
    await post(`/users/${ana.id}/delete`, { comment: comment.id });
    await h.app.settled();
    const sent = webhooks().length;
    expect(await refusal(post(`/users/${ana.id}/delete`, { comment: comment.id }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/edit`, { body: "again", comment: comment.id }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/react`, { content: "heart", comment: comment.id }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/minimize`, { comment: comment.id }))).toBe("not_found");
    expect(await refusal(get(`/comments/${comment.id}`))).toBe("not_found");

    // The same for a comment on the diff.
    const pr = await pull();
    const inline = await post(`/users/${ana.id}/review-comment`, {
      body: "hm",
      pr: pr.ref,
      path: "src/app.ts",
      line: 1,
    });
    await post(`/users/${ana.id}/delete`, { comment: inline.id });
    await h.app.settled();
    const after = webhooks().length;
    expect(await refusal(post(`/users/${ana.id}/reply`, { body: "?", comment: inline.id }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/resolve`, { comment: inline.id }))).toBe("not_found");
    await h.app.settled();
    // Nothing more was sent about either of them.
    expect(
      webhooks()
        .slice(sent)
        .map((hook) => `${hook.event}.${hook.payload.action}`),
    ).not.toContain("issue_comment.deleted");
    expect(webhooks()).toHaveLength(after);
  });

  test("the App needs the permission an endpoint asks for", async () => {
    const { api, path, issue } = await workspace();
    const { number } = await issue();
    // The default App has no `administration` or `actions`; what it has, it may use.
    expect((await api("POST", `${path}/issues/${number}/comments`, { body: "ok" })).status).toBe(201);
    expect((await api("POST", `${path}/issues/${number}/comments`, { body: "  " })).status).toBe(422);
    expect((await api("POST", `${path}/issues/${number}/comments`, {})).body).toMatchObject({
      message: "Validation Failed",
      errors: [{ resource: "IssueComment", field: "body", code: "missing_field" }],
    });
  });
});

describe("code", () => {
  test("a repository starts with a commit, and files given to it are its first tree", async () => {
    const { ana, repo, post, get } = await workspace();
    expect(await get(`/repos/${repo.id}/file?path=README.md`)).toBe(`# ${repo.name}\n`);
    expect(await get(`/repos/${repo.id}/file?path=nope.md`)).toBeNull();
    const seeded = await post("/repos", {
      name: "web",
      collaborators: [{ user: ana.id }],
      files: [
        { path: "src/app.ts", content: b64("export {}\n") },
        { path: "README.md", content: b64("# web\n") },
      ],
      labels: [{ name: "agent:fix", color: "#ff0000" }],
    });
    expect(seeded).toMatchObject({ name: "web", fullName: "acme/web", defaultBranch: "main" });
    expect(await get(`/repos/${seeded.id}/file?path=src/app.ts`)).toBe("export {}\n");
    const [first] = await get(`/repos/${seeded.id}/commits`);
    expect(first).toMatchObject({ message: "Initial commit", branch: "main" });
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    // Nobody on GitHub wrote the first commit.
    expect(first.author).toBeUndefined();
    expect(await refusal(get(`/repos/${seeded.id}/commits?branch=nope`))).toBe("not_found");
  });

  test("a push sends `push`, moves the pull request's head and sends `synchronize`", async () => {
    const { h, ana, repo, pull, post, get, webhooks, api, path } = await workspace();
    const pr = await pull();
    await h.app.settled();
    const before = (await api("GET", `${path}/pulls/${pr.number}`)).body;
    expect(before).toMatchObject({ commits: 1, changed_files: 1, additions: 1, deletions: 0, head: { ref: "feat" } });

    const commit = await post(`/users/${ana.id}/push`, {
      changes: [
        { path: "src/app.ts", content: b64("export const y = 2\n") },
        { path: "src/gone.ts", content: null },
      ],
      repo: repo.id,
      branch: "feat",
      message: "Rename",
    });
    await h.app.settled();
    expect(commit).toMatchObject({ message: "Rename", branch: "feat", author: { login: "ana" } });
    const events = webhooks().slice(-2);
    expect(events.map((hook) => `${hook.event}.${hook.payload.action ?? ""}`)).toEqual([
      "push.",
      "pull_request.synchronize",
    ]);
    expect(events[0]?.payload).toMatchObject({
      ref: "refs/heads/feat",
      before: before.head.sha,
      after: commit.sha,
      created: false,
      commits: [{ id: commit.sha, message: "Rename", modified: ["src/app.ts"] }],
      pusher: { name: "ana" },
    });
    expect(events[1]?.payload).toMatchObject({ before: before.head.sha, after: commit.sha, number: pr.number });
    expect((await get(`/repos/${repo.id}/pulls/${pr.number}/head-commit`)).sha).toBe(commit.sha);
    expect((await api("GET", `${path}/pulls/${pr.number}`)).body).toMatchObject({
      commits: 2,
      head: { sha: commit.sha },
    });
  });

  test("the contents API guards against overwriting, and refs only move forward without `force`", async () => {
    const { api, path } = await workspace();
    const readme = (await api("GET", `${path}/contents/README.md`)).body;
    const put = (body: object) =>
      api("PUT", `${path}/contents/README.md`, { message: "m", content: b64("x"), ...body });
    expect((await put({})).status).toBe(422);
    expect((await put({ sha: "0".repeat(40) })).status).toBe(409);
    expect((await put({ sha: readme.sha, branch: "nope" })).status).toBe(404);
    const updated = await put({ sha: readme.sha });
    expect(updated.status).toBe(200);
    // The commit is the App's own.
    expect(updated.body.commit.author).toMatchObject({ name: "my-agent[bot]" });

    const main = (await api("GET", `${path}/git/ref/heads/main`)).body.object.sha;
    const parent = (await api("GET", `${path}/git/commits/${main}`)).body.parents[0].sha;
    expect((await api("POST", `${path}/git/refs`, { ref: "refs/heads/main", sha: main })).status).toBe(422);
    expect((await api("POST", `${path}/git/refs`, { ref: "heads/x", sha: main })).status).toBe(422);
    expect((await api("POST", `${path}/git/refs`, { ref: "refs/heads/x", sha: "f".repeat(40) })).status).toBe(422);
    expect((await api("PATCH", `${path}/git/refs/heads/main`, { sha: parent })).body.message).toBe(
      "Update is not a fast forward",
    );
    expect((await api("PATCH", `${path}/git/refs/heads/main`, { sha: parent, force: true })).status).toBe(200);
    expect((await api("GET", `${path}/git/ref/heads/nope`)).status).toBe(404);
  });

  test("a path or a ref that names the route's own segment again is taken whole", async () => {
    const { api, path } = await workspace();
    const put = await api("PUT", `${path}/contents/docs/contents/x.md`, { message: "Add", content: b64("x\n") });
    expect(put.body.content).toMatchObject({ name: "x.md", path: "docs/contents/x.md" });
    expect((await api("GET", `${path}/contents/docs/contents/x.md`)).body.path).toBe("docs/contents/x.md");
    const main = (await api("GET", `${path}/git/ref/heads/main`)).body.object.sha;
    await api("POST", `${path}/git/refs`, { ref: "refs/heads/feat/branches/x", sha: main });
    expect((await api("GET", `${path}/branches/feat/branches/x`)).body.name).toBe("feat/branches/x");
    expect((await api("GET", `${path}/git/ref/heads/feat/branches/x`)).body.ref).toBe("refs/heads/feat/branches/x");
  });

  test("a body is parsed in one place: bad JSON is GitHub's 400, and a DELETE's body is on record", async () => {
    const { h, api, path, issue, get, token, raw } = await workspace();
    const { number } = await issue();
    const send = async (method: string, body: string) =>
      h.app.fetch(
        new Request(`http://127.0.0.1:4500/github${path}/issues/${number}/assignees`, {
          method,
          headers: { authorization: `token ${await token()}`, "content-type": "application/json" },
          body,
        }),
      );
    for (const method of ["POST", "DELETE"]) {
      const bad = await send(method, "{not json");
      expect([bad.status, ((await bad.json()) as { message: string }).message]).toEqual([400, "Problems parsing JSON"]);
    }
    expect((await send("POST", "null")).status).toBe(400);
    expect((await raw("GET", `${path}/issues/${number}`, `token ${await token()}`)).status).toBe(200);

    await api("POST", `${path}/issues/${number}/assignees`, { assignees: ["ana"] });
    await api("DELETE", `${path}/issues/${number}/assignees`, { assignees: ["ana"] });
    const calls = await get("/calls");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", request: { assignees: ["ana"] }, responseStatus: 200 });
  });

  test("a path the fake doesn't serve is GitHub's 404, under both roots", async () => {
    const { raw, path, token, get } = await workspace();
    const auth = `token ${await token()}`;
    for (const unknown of [`${path}/milestones`, `/api/v3${path}/milestones`, "/rate_limit", "/api/v3/nothing/here"]) {
      const response = await raw("GET", unknown, auth);
      expect([response.status, await response.json()]).toEqual([
        404,
        { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" },
      ]);
    }
    expect((await raw("POST", "/graphql", auth, { query: "{ viewer { login } }" })).status).toBe(404);
    // What didn't authenticate is on no record; what did and names no repository is on the App's.
    await raw("GET", "/nothing/at/all");
    await raw("GET", "/app", "Bearer made-up");
    const about = (await get("/app-calls")).map((call: { operation: string }) => call.operation);
    expect(about).toContain("GET /rate_limit");
    expect(about).not.toContain("GET /nothing/at/all");
    expect(about).not.toContain("GET /app");
  });

  test("patches have the headers git writes: an empty side, a single line, a range", async () => {
    const { ana, repo, post, api, path } = await workspace();
    const pr = await post(`/users/${ana.id}/pulls`, {
      pr: {
        from: "feat",
        title: "Headers",
        changes: [
          { path: "added.txt", content: b64("one\n") },
          { path: "two.txt", content: b64("one\ntwo\n") },
          { path: "README.md", content: null },
        ],
      },
      repo: repo.id,
    });
    const files = (await api("GET", `${path}/pulls/${pr.number}/files`)).body as Array<{
      filename: string;
      patch: string;
    }>;
    const header = (name: string) => files.find((file) => file.filename === name)?.patch.split("\n")[0];
    expect(header("added.txt")).toBe("@@ -0,0 +1 @@");
    expect(header("two.txt")).toBe("@@ -0,0 +1,2 @@");
    expect(header("README.md")).toBe("@@ -1 +0,0 @@");
    // A comment on the first added line carries that header, and the line is where git says it is.
    const comment = await post(`/users/${ana.id}/review-comment`, {
      body: "here",
      pr: { repoId: repo.id, number: pr.number },
      path: "two.txt",
      line: 2,
    });
    expect((await api("GET", `${path}/pulls/comments/${comment.id}`)).body.diff_hunk).toBe(
      "@@ -0,0 +1,2 @@\n+one\n+two",
    );
  });

  test("what can't be read is refused, not a server error: a bad escape, a date that isn't one, a label with a %", async () => {
    const { api, path, issue, pull, raw, token } = await workspace();
    const auth = `token ${await token()}`;
    for (const bad of ["/contents/%E0%A4%A", "/branches/%", "/git/ref/heads/%zz"]) {
      expect((await raw("GET", `${path}${bad}`, auth)).status).toBe(404);
    }
    const pr = await pull();
    const sha = (await api("GET", `${path}/pulls/${pr.number}`)).body.head.sha;
    const run = await api("POST", `${path}/check-runs`, { name: "lint", head_sha: sha, started_at: "yesterday" });
    expect([run.status, run.body.errors]).toEqual([
      422,
      [{ resource: "CheckRun", field: "started_at", code: "invalid" }],
    ]);

    const { number } = await issue();
    await api("POST", `${path}/labels`, { name: "50% done" });
    await api("POST", `${path}/issues/${number}/labels`, { labels: ["50% done"] });
    expect((await api("GET", `${path}/labels/50%25%20done`)).body.name).toBe("50% done");
    expect((await api("DELETE", `${path}/issues/${number}/labels/50%25%20done`)).body).toEqual([]);
  });

  test("lists are paged the way GitHub pages them", async () => {
    const { raw, path, token, issue } = await workspace();
    for (const title of ["one", "two", "three"]) await issue(title);
    const response = await raw("GET", `${path}/issues?per_page=2`, `token ${await token()}`);
    const titles = ((await response.json()) as Array<{ title: string }>).map((item) => item.title);
    expect(titles).toEqual(["three", "two"]);
    expect(response.headers.get("link")).toMatch(
      /<[^>]*[?&]page=2[^>]*>; rel="next", <[^>]*[?&]page=2[^>]*>; rel="last"/,
    );
    const second = await raw("GET", `${path}/issues?per_page=2&page=2`, `token ${await token()}`);
    expect(second.headers.get("link")).toContain('rel="prev"');
    expect(await second.json()).toHaveLength(1);
  });
});

describe("pull requests", () => {
  test("`synchronize` is sent even when a read brought the pull request up to date first", async () => {
    const { h, ana, repo, pull, post, get, webhooks } = await workspace();
    const pr = await pull();
    await h.app.settled();
    // Reads of the pull request's head keep coming while the push is made: none of them may swallow the event.
    let pushing = true;
    const reading = (async () => {
      while (pushing) await get(`/repos/${repo.id}/pulls/${pr.number}/check-runs`);
    })();
    const commit = await post(`/users/${ana.id}/push`, {
      changes: [{ path: "src/app.ts", content: b64("export const z = 3\n") }],
      repo: repo.id,
      branch: "feat",
    });
    pushing = false;
    await reading;
    await h.app.settled();
    expect(webhooks().at(-1)).toMatchObject({
      event: "pull_request",
      payload: { action: "synchronize", after: commit.sha },
    });
  });

  test("GitHub's refusals when opening one", async () => {
    const { ana, repo, pull, post, api, path } = await workspace();
    const open = (pr: object) => refusal(post(`/users/${ana.id}/pulls`, { pr, repo: repo.id }));
    expect(await open({ from: "nope" })).toBe("validation_failed");
    expect(await open({ from: "main" })).toBe("validation_failed");
    await pull();
    // One open pull request per branch pair.
    expect(await open({ from: "feat" })).toBe("validation_failed");
    expect(
      (await api("POST", `${path}/pulls`, { head: "feat", base: "main", title: "Again" })).body.errors[0].message,
    ).toMatch(/A pull request already exists for acme:feat/);
    expect((await api("POST", `${path}/pulls`, { head: "feat", base: "main" })).status).toBe(422);
  });

  test("a review is checked before any of it is kept", async () => {
    const { h, ana, pull, post, get, webhooks } = await workspace();
    const pr = await pull();
    const ben = await post("/users", { login: "ben" });
    await h.app.settled();
    const before = webhooks().length;
    const review = (who: { id: string }, body: object) =>
      refusal(post(`/users/${who.id}/review`, { review: { pr: pr.ref, ...body } }));

    expect(await review(ana, { event: "APPROVE" })).toBe("validation_failed");
    expect(await review(ben, { event: "REQUEST_CHANGES" })).toBe("validation_failed");
    expect(await review(ben, { event: "COMMENT" })).toBe("validation_failed");
    // The second comment sits on a line the diff doesn't have: the first one isn't kept either.
    const comments = [
      { path: "src/app.ts", line: 1, body: "fine" },
      { path: "src/app.ts", line: 40, body: "nowhere" },
    ];
    expect(await review(ben, { event: "COMMENT", comments })).toBe("validation_failed");
    expect(
      await review(ben, { event: "COMMENT", comments: [{ path: "README.md", line: 1, body: "not in the diff" }] }),
    ).toBe("validation_failed");
    await h.app.settled();
    expect(await get(`/repos/${pr.repoId}/pulls/${pr.number}/reviews`)).toEqual([]);
    expect(await get(`/repos/${pr.repoId}/pulls/${pr.number}/review-comments`)).toEqual([]);
    expect(webhooks()).toHaveLength(before);

    const approved = await post(`/users/${ben.id}/review`, {
      review: { pr: pr.ref, event: "APPROVE", body: "Ship it" },
    });
    await h.app.settled();
    expect(approved).toMatchObject({ state: "APPROVED", body: "Ship it", author: { login: "ben" } });
    expect(webhooks().at(-1)?.payload).toMatchObject({ action: "submitted", review: { state: "approved" } });
  });

  test("a pending review is held to the same rules when it is submitted", async () => {
    const { h, ana, repo, post, api, path, webhooks } = await workspace();
    await post(`/users/${ana.id}/push`, {
      changes: [{ path: "a.txt", content: b64("a\n") }],
      repo: repo.id,
      branch: "bot",
    });
    const own = (await api("POST", `${path}/pulls`, { head: "bot", base: "main", title: "From the App" })).body;
    await h.app.settled();
    const before = webhooks().length;
    const reviews = `${path}/pulls/${own.number}/reviews`;

    // Its own pull request: not directly, and not through a pending review either.
    expect((await api("POST", reviews, { event: "APPROVE" })).status).toBe(422);
    const pending = (await api("POST", reviews, {})).body;
    expect(pending.state).toBe("PENDING");
    expect((await api("POST", `${reviews}/${pending.id}/events`, { event: "APPROVE" })).status).toBe(422);
    expect((await api("POST", `${reviews}/${pending.id}/events`, { event: "REQUEST_CHANGES" })).status).toBe(422);
    const blank = await api("POST", `${reviews}/${pending.id}/events`, { event: "COMMENT" });
    expect([blank.status, blank.body.errors]).toEqual([422, ["Body can't be blank"]]);
    await h.app.settled();
    expect(webhooks()).toHaveLength(before);

    // Someone who was asked for a review isn't any more once they have given it.
    const ben = await post("/users", { login: "ben" });
    const ref = { repoId: repo.id, number: own.number };
    await api("POST", `${path}/pulls/${own.number}/requested_reviewers`, { reviewers: ["ben"] });
    await post(`/users/${ben.id}/review`, { review: { pr: ref, event: "COMMENT", body: "Fine" } });
    expect((await api("GET", `${path}/pulls/${own.number}/requested_reviewers`)).body.users).toEqual([]);
    const said = await api("POST", `${reviews}/${pending.id}/events`, { event: "COMMENT", body: "Done thinking" });
    expect(said.body).toMatchObject({ state: "COMMENTED", body: "Done thinking" });
  });

  test("a thread stays one thread when the comment that started it is deleted", async () => {
    const { h, ana, pull, post, get, api, path, webhooks } = await workspace();
    const pr = await pull();
    const root = await post(`/users/${ana.id}/review-comment`, {
      body: "root",
      pr: pr.ref,
      path: "src/app.ts",
      line: 1,
    });
    const replies = `${path}/pulls/${pr.number}/comments/${root.id}/replies`;
    const one = (await api("POST", replies, { body: "reply one" })).body;
    const two = (await api("POST", replies, { body: "reply two" })).body;
    await post(`/users/${ana.id}/delete`, { comment: root.id });

    const transcript = async () => (await get(`/repos/${pr.repoId}/issues/${pr.number}/transcript`)).text;
    // The oldest comment left reads as the thread's first, with where it is.
    expect(await transcript()).toBe(
      ["ana: Add app", "my-agent: src/app.ts:1: reply one", "  my-agent: reply two"].join("\n"),
    );
    expect((await get(`/review-comments/${one.id}/replies`)).map((reply: { body: string }) => reply.body)).toEqual([
      "reply two",
    ]);
    expect((await get(`/review-comments/${two.id}/transcript`)).text).toBe(
      "my-agent: src/app.ts:1: reply one\n  my-agent: reply two",
    );

    // A new reply joins the same thread, and resolving it names all that is left of it.
    const three = await post(`/users/${ana.id}/reply`, { body: "reply three", comment: two.id });
    await post(`/users/${ana.id}/resolve`, { comment: three.id });
    await h.app.settled();
    expect(
      webhooks()
        .at(-1)
        ?.payload.thread.comments.map((comment: { body: string }) => comment.body),
    ).toEqual(["reply one", "reply two", "reply three"]);
    expect(await get(`/review-comments/${one.id}/resolved`)).toBe(true);
  });

  test("a thread on the diff: reply, resolve, and how a person reads it", async () => {
    const { h, ana, pull, post, get, api, path, webhooks } = await workspace();
    const pr = await pull();
    const inline = await post(`/users/${ana.id}/review-comment`, {
      body: "why?",
      pr: pr.ref,
      path: "src/app.ts",
      line: 1,
    });
    expect(inline).toMatchObject({ path: "src/app.ts", line: 1, side: "RIGHT", author: { login: "ana" } });
    const reply = (await api("POST", `${path}/pulls/${pr.number}/comments/${inline.id}/replies`, { body: "Because." }))
      .body;
    expect(reply).toMatchObject({
      in_reply_to_id: inline.id,
      path: "src/app.ts",
      user: { login: "my-agent[bot]", type: "Bot" },
    });
    // A reply to a reply still hangs on the comment that started the thread.
    const second = await post(`/users/${ana.id}/reply`, { body: "ok", comment: reply.id });
    expect((await get(`/review-comments/${second.id}/replies`)).map((item: { body: string }) => item.body)).toEqual([
      "Because.",
      "ok",
    ]);
    expect(await get(`/review-comments/${inline.id}/resolved`)).toBe(false);
    await post(`/users/${ana.id}/resolve`, { comment: reply.id });
    await h.app.settled();
    expect(await get(`/review-comments/${inline.id}/resolved`)).toBe(true);
    expect(webhooks().at(-1)).toMatchObject({ event: "pull_request_review_thread", payload: { action: "resolved" } });
    expect((await get(`/review-comments/${inline.id}/transcript`)).text).toBe(
      ["ana: src/app.ts:1: why?", "  my-agent: Because.", "  ana: ok"].join("\n"),
    );
    expect((await get(`/repos/${pr.repoId}/issues/${pr.number}/transcript`)).text).toContain("ana: Add app");
  });

  test("merging: a draft can't be, each method makes its own history, and a conflict is refused", async () => {
    const { h, ana, repo, pull, post, get, api, path, webhooks } = await workspace();
    const draft = await pull("export const x = 1\n", { draft: true });
    expect(await refusal(post(`/users/${ana.id}/merge`, { pr: draft.ref }))).toBe("not_allowed");
    expect(await refusal(post(`/users/${ana.id}/mark-ready`, { pr: { ...draft.ref, number: 99 } }))).toBe("not_found");
    await post(`/users/${ana.id}/mark-ready`, { pr: draft.ref });
    expect(await refusal(post(`/users/${ana.id}/mark-ready`, { pr: draft.ref }))).toBe("validation_failed");
    await h.app.settled();

    const merged = await post(`/users/${ana.id}/merge`, { pr: draft.ref, method: "squash" });
    await h.app.settled();
    expect(merged).toMatchObject({ type: "pull_request", action: "closed" });
    expect(
      webhooks()
        .slice(-2)
        .map((hook) => hook.event),
    ).toEqual(["push", "pull_request"]);
    expect(await get(`/repos/${repo.id}/pulls/${draft.number}/merged`)).toBe(true);
    const [tip] = await get(`/repos/${repo.id}/commits`);
    expect(tip.message).toBe(`Add app (#${draft.number})`);
    // A squash has one parent: the base as it was.
    expect((await api("GET", `${path}/git/commits/${tip.sha}`)).body.parents).toHaveLength(1);
    expect(await refusal(post(`/users/${ana.id}/merge`, { pr: draft.ref }))).toBe("not_allowed");
    expect(await refusal(post(`/users/${ana.id}/reopen`, { issue: draft.ref }))).toBe("validation_failed");

    // Two branches change the same file: the second one can't be merged after the first.
    const change = (branch: string, text: string) => ({
      pr: { from: branch, title: branch, changes: [{ path: "README.md", content: b64(text) }] },
      repo: repo.id,
    });
    const one = await post(`/users/${ana.id}/pulls`, change("one", "# one\n"));
    const two = await post(`/users/${ana.id}/pulls`, change("two", "# two\n"));
    await post(`/users/${ana.id}/merge`, { pr: { repoId: repo.id, number: one.number } });
    const [mergeCommit] = await get(`/repos/${repo.id}/commits`);
    expect((await api("GET", `${path}/git/commits/${mergeCommit.sha}`)).body.parents).toHaveLength(2);
    expect((await api("PUT", `${path}/pulls/${two.number}/merge`, {})).status).toBe(405);
    expect(await get(`/repos/${repo.id}/pulls/${two.number}/merged`)).toBe(false);
  });
});

describe("check runs", () => {
  test("the newest run of a name is what a commit shows; a person can only press buttons that are there", async () => {
    const { h, ana, pull, post, get, api, path, webhooks } = await workspace();
    const pr = await pull();
    const sha = (await api("GET", `${path}/pulls/${pr.number}`)).body.head.sha;
    const create = (body: object) => api("POST", `${path}/check-runs`, { name: "my-agent", head_sha: sha, ...body });
    expect((await create({ status: "completed" })).status).toBe(422);
    expect((await create({ head_sha: "f".repeat(40) })).status).toBe(422);
    await create({ conclusion: "failure" });
    const run = (
      await create({
        conclusion: "action_required",
        output: { title: "1 problem", summary: "s" },
        actions: [{ label: "Fix", description: "Fix it", identifier: "autofix" }],
      })
    ).body;
    await h.app.settled();
    // Created as completed: GitHub says so in two events.
    expect(
      webhooks()
        .slice(-2)
        .map((hook) => `${hook.event}.${hook.payload.action}`),
    ).toEqual(["check_run.created", "check_run.completed"]);

    expect(await get(`/repos/${pr.repoId}/pulls/${pr.number}/check-runs`)).toMatchObject([
      { id: run.id, conclusion: "action_required", status: "completed", title: "1 problem", actions: ["autofix"] },
    ]);
    expect((await api("GET", `${path}/commits/${sha}/check-runs?filter=all`)).body.total_count).toBe(2);
    expect(await refusal(post(`/users/${ana.id}/request-action`, { identifier: "nope", checkRun: run.id }))).toBe(
      "not_found",
    );
    expect((await post(`/users/${ana.id}/request-action`, { identifier: "autofix", checkRun: run.id })).action).toBe(
      "requested_action",
    );
    expect((await post(`/users/${ana.id}/rerun`, { checkRun: run.id })).action).toBe("rerequested");
    await h.app.settled();
    expect(webhooks().at(-1)?.payload).toMatchObject({
      action: "rerequested",
      check_run: { id: run.id },
      sender: { login: "ana" },
    });
  });

  test("a name or a context that reports again is the newest", async () => {
    const { pull, api, path } = await workspace();
    const pr = await pull();
    const sha = (await api("GET", `${path}/pulls/${pr.number}`)).body.head.sha;
    for (const context of ["a", "b", "a"]) await api("POST", `${path}/statuses/${sha}`, { state: "success", context });
    const combined = (await api("GET", `${path}/commits/${sha}/status`)).body;
    expect(combined.statuses.map((status: { context: string }) => status.context)).toEqual(["a", "b"]);
    for (const name of ["lint", "test", "lint"])
      await api("POST", `${path}/check-runs`, { name, head_sha: sha, conclusion: "success" });
    const runs = (await api("GET", `${path}/commits/${sha}/check-runs`)).body.check_runs;
    expect(runs.map((run: { name: string }) => run.name)).toEqual(["test", "lint"]);
  });

  test("a check run that never completes is the agent's open work", async () => {
    const { h, sessionId, pull, api, path } = await workspace();
    const pr = await pull();
    const sha = (await api("GET", `${path}/pulls/${pr.number}`)).body.head.sha;
    const run = (await api("POST", `${path}/check-runs`, { name: "lint", head_sha: sha, status: "in_progress" })).body;
    await h.app.settled();
    const quiet = async () => (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect((await quiet()).open).toEqual([`a check run "lint" on ${sha.slice(0, 7)} that never completed`]);
    expect((await api("PATCH", `${path}/check-runs/${run.id}`, { conclusion: "success" })).body).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    await h.app.settled();
    expect((await quiet()).open).toEqual([]);
  });
});

describe("sessions in one org", () => {
  test("logins are per session, repository names and fixed ids are one in the world", async () => {
    const { h, ana, repo, post } = await workspace();
    const other = (await h.call("POST", "/sessions")).body.sessionId;
    const there = (path: string, body: unknown) => h.call("POST", `/sessions/${other}/github${path}`, body);

    const twin = (await there("/users", { login: "ana" })).body;
    expect(twin.id).not.toBe(ana.id);
    expect(await refusal(post("/users", { login: "ana" }))).toBe("invalid_argument");
    expect(await refusal(post("/users", { login: "-bad-" }))).toBe("invalid_argument");

    await post("/repos", { name: "web" });
    expect((await there("/repos", { name: "web" })).body.error).toBe("invalid_argument");
    await post("/users", { login: "fixed", id: 4242 });
    expect((await there("/users", { login: "fixed-too", id: 4242 })).body.error).toBe("invalid_argument");
    // What belongs to one session isn't there for another.
    expect((await h.call("GET", `/sessions/${other}/github/repos/${repo.id}/commits`)).status).toBe(404);
    expect((await there(`/users/${ana.id}/issues`, { issue: { title: "x" }, repo: repo.id })).status).toBe(404);
  });

  test("closing a session frees its names and ids, and takes its repositories with it", async () => {
    const { h, sessionId, repo, post, raw, token } = await workspace();
    await post("/repos", { name: "web" });
    await post("/users", { login: "fixed", id: 4242 });
    const auth = `token ${await token()}`;
    await h.call("DELETE", `/sessions/${sessionId}`);
    expect((await raw("GET", `/repos/acme/${repo.name}`, auth)).status).toBe(404);

    const next = (await h.call("POST", "/sessions")).body.sessionId;
    expect((await h.call("POST", `/sessions/${next}/github/repos`, { name: "web" })).status).toBe(200);
    expect((await h.call("POST", `/sessions/${next}/github/users`, { login: "fixed", id: 4242 })).status).toBe(200);
  });

  test("the agent's calls are on record for the session that owns the repository", async () => {
    const { h, api, path, get, issue } = await workspace();
    const { number } = await issue();
    await api("POST", `${path}/issues/${number}/comments`, { body: "On it" });
    await api("GET", `${path}/issues/999`);
    const calls = await get("/calls");
    expect(calls.map((call: { operation: string }) => call.operation)).toEqual([
      `POST ${path}/issues/${number}/comments`,
      `GET ${path}/issues/999`,
    ]);
    expect(calls[0]).toMatchObject({
      channel: "github",
      method: "POST",
      responseStatus: 201,
      request: { body: "On it" },
    });
    expect(await get("/calls?error=true")).toMatchObject([{ responseStatus: 404, error: "Not Found" }]);
    // The App's own endpoints are about no repository: they are in no session's calls, and in `app-calls` for all.
    const about = (await get("/app-calls")).map((call: { operation: string }) => call.operation);
    expect(about).toContain("GET /app/installations");
    const exchange = (await get("/app-calls")).find((call: { path: string }) => call.path.endsWith("/access_tokens"));
    expect(exchange).toMatchObject({ method: "POST", responseStatus: 201, response: { token: "[redacted]" } });
    // Nothing a session's log holds shows the installation token.
    const other = (await h.call("POST", "/sessions")).body.sessionId;
    expect((await h.call("GET", `/sessions/${other}/github/calls`)).body).toEqual([]);
  });
});
