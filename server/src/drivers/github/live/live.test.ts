import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type GitHubStub, githubStub } from "../../../../test/github-live-stub.ts";

/** A server whose GitHub driver is live against the stub: the App's credentials and the allowlist set, as in CI. */
function liveGitHub(stub: GitHubStub, allowlist = stub.org, extra: Record<string, string> = {}) {
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_GITHUB_APP_ID: String(stub.app.id),
          // In one environment line, as CI and .env files keep it.
          CHANNELSTACK_GITHUB_PRIVATE_KEY: stub.privateKey.replaceAll("\n", "\\n"),
          CHANNELSTACK_LIVE_GITHUB_ORGS: allowlist,
          CHANNELSTACK_RUN_ID: "unit4",
          ...extra,
        },
        fetch: stub.fetch,
        apiBase: { github: stub.url },
      },
    },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      github: (method: string, path: string, payload?: unknown) =>
        server.call(method, `/sessions/${body.sessionId}/github${path}`, payload),
    };
  };
  return { ...server, open };
}

describe("exit check 5.3: GitHub's allowlist holds", () => {
  test("an org outside CHANNELSTACK_LIVE_GITHUB_ORGS is refused before anything is done there", async () => {
    const stub = githubStub();
    const ana = stub.person("ana-channelstack");
    const session = await liveGitHub(stub, "not-this-org").open();
    const person = await session.github("POST", "/users", { login: "ana-channelstack", token: ana.token });
    expect(person.body.error).toBe("live_not_allowlisted");
    expect(person.body.message).toContain("CHANNELSTACK_LIVE_GITHUB_ORGS");
    expect(stub.calls.every((call) => call.method === "GET" || call.path.endsWith("/access_tokens"))).toBe(true);
  });

  test("an App on a user account, or a token that is someone else's, is refused", async () => {
    const onUser = githubStub();
    onUser.onUserAccount();
    const refused = await (await liveGitHub(onUser).open()).github("POST", "/users", { login: "ana" });
    expect(refused.body.error).toBe("live_misconfigured");
    expect(refused.body.message).toContain("a user account");

    const stub = githubStub();
    const ben = stub.person("ben-channelstack");
    const session = await liveGitHub(stub).open();
    const wrong = await session.github("POST", "/users", { login: "ana-channelstack", token: ben.token });
    expect(wrong.body.error).toBe("live_misconfigured");
    expect(wrong.body.message).toContain("ana-channelstack's token is ben-channelstack's");
  });
});

describe("live GitHub: acting and reading back", () => {
  test("a real person comments on a real repo's issue, and the App's answer and delivery are read back", async () => {
    const stub = githubStub();
    const ana = stub.person("ana-channelstack");
    const server = liveGitHub(stub);
    const session = await server.open();

    const fixture = await session.github("GET", "");
    expect(fixture.body.app).toMatchObject({ appId: stub.app.id, slug: "my-agent", privateKey: "", webhookSecret: "" });
    expect(fixture.body).toMatchObject({ apiUrl: "https://api.github.com", org: stub.org });
    expect(JSON.stringify(fixture.body)).not.toContain("PRIVATE KEY");

    const person = await session.github("POST", "/users", { login: "ana-channelstack", token: ana.token });
    expect(person.body).toMatchObject({ id: String(ana.id), login: "ana-channelstack" });
    expect(person.body.email).toBeUndefined();

    const repo = await session.github("POST", "/repos", {
      collaborators: [{ user: person.body.id }],
      apps: [fixture.body.app.id],
      labels: [{ name: "bug" }],
      files: [{ path: "src/index.ts", content: Buffer.from("export {};\n").toString("base64") }],
    });
    expect(repo.status).toBe(200);
    // Unique in a real org: the run's tag in the name.
    expect(repo.body.name).toBe("channelstack-run-unit4-1");
    // Invited, and accepted as herself.
    expect(stub.repo(repo.body.name)).toMatchObject({ collaborators: ["ana-channelstack"], labels: ["bug"] });
    expect(stub.calls.find((call) => call.path.startsWith("/user/repository_invitations/"))?.as).toBe(
      "ana-channelstack",
    );
    expect((await session.github("GET", `/repos/${repo.body.id}/file?path=src/index.ts`)).body).toBe("export {};\n");
    expect((await session.github("GET", `/repos/${repo.body.id}/file?path=missing.ts`)).body).toBeNull();

    const issue = await session.github("POST", `/users/${person.body.id}/issues`, {
      issue: { title: "Live smoke test" },
      repo: repo.body.id,
    });
    expect(issue.body).toMatchObject({ number: 1, author: { login: "ana-channelstack" } });
    expect(issue.body.url).toBe(`https://github.com/${stub.org}/${repo.body.name}/issues/1`);
    const ref = { repoId: repo.body.id, number: 1 };
    const comment = await session.github("POST", `/users/${person.body.id}/comment`, {
      body: "@my-agent please triage",
      issue: ref,
    });
    expect(comment.body).toMatchObject({ body: "@my-agent please triage", author: { login: "ana-channelstack" } });
    expect(stub.calls.find((call) => call.method === "POST" && call.path.endsWith("/issues/1/comments"))?.as).toBe(
      "ana-channelstack",
    );

    // GitHub delivers to the agent; here it answers the way it would.
    stub.agentComments(repo.body.name, 1, "Triaged: a bug in the login form");
    const comments = await session.github("GET", `/repos/${repo.body.id}/issues/1/comments`);
    expect(comments.body).toHaveLength(2);
    expect(comments.body[1]).toMatchObject({ body: "Triaged: a bug in the login form", author: { kind: "app" } });

    const deliveries = await session.github("GET", `/deliveries?type=issue_comment&resource=${repo.body.id}`);
    expect(deliveries.body).toHaveLength(1);
    expect(deliveries.body[0]).toMatchObject({ type: "issue_comment", action: "created" });
    expect(deliveries.body[0].attempts[0]).toMatchObject({
      status: "acknowledged",
      responseStatus: 200,
      durationMs: 250,
      url: "https://agent.example/webhooks",
    });
    const again = await session.github("POST", `/deliveries/${deliveries.body[0].id}/redeliver`);
    expect(again.body).toMatchObject({ number: 2, status: "pending" });
    expect((await session.github("GET", `/deliveries/${deliveries.body[0].id}`)).body.attempts).toHaveLength(2);
  });

  test("a person labels, assigns, edits, closes and changes their own comments", async () => {
    const stub = githubStub();
    const ana = stub.person("ana-channelstack");
    const ben = stub.person("ben-channelstack");
    const session = await liveGitHub(stub).open();
    const fixture = await session.github("GET", "");
    const a = await session.github("POST", "/users", { login: "ana-channelstack", token: ana.token });
    const b = await session.github("POST", "/users", { login: "ben-channelstack", token: ben.token });
    const repo = await session.github("POST", "/repos", {
      collaborators: [{ user: a.body.id }, { user: b.body.id }],
      apps: [fixture.body.app.id],
      labels: [{ name: "bug" }],
    });
    await session.github("POST", `/users/${a.body.id}/issues`, { issue: { title: "Typo" }, repo: repo.body.id });
    const issue = { repoId: repo.body.id, number: 1 };

    await session.github("POST", `/users/${a.body.id}/label`, { labels: ["bug"], issue });
    expect((await session.github("GET", `/repos/${repo.body.id}/issues/1/labels`)).body).toEqual(["bug"]);
    await session.github("POST", `/users/${a.body.id}/assign`, { assignees: [b.body.id], issue });
    expect((await session.github("GET", `/repos/${repo.body.id}/issues/1/assignees`)).body).toEqual([
      expect.objectContaining({ login: "ben-channelstack" }),
    ]);
    const asApp = await session.github("POST", `/users/${a.body.id}/assign`, {
      assignees: [fixture.body.app.id],
      issue,
    });
    expect(asApp.body.error).toBe("unsupported_in_live");
    await session.github("POST", `/users/${a.body.id}/edit-issue`, { changes: { title: "Typo in README" }, issue });
    expect((await session.github("GET", `/repos/${repo.body.id}/issues/1/title`)).body).toBe("Typo in README");
    await session.github("POST", `/users/${a.body.id}/close`, { issue });
    expect((await session.github("GET", `/repos/${repo.body.id}/issues/1/state`)).body).toBe("closed");

    const comment = await session.github("POST", `/users/${a.body.id}/comment`, { body: "first", issue });
    await session.github("POST", `/users/${a.body.id}/edit`, { body: "edited", comment: comment.body.id });
    expect((await session.github("GET", `/comments/${comment.body.id}`)).body.body).toBe("edited");
    const notHers = await session.github("POST", `/users/${b.body.id}/edit`, {
      body: "mine",
      comment: comment.body.id,
    });
    expect(notHers.body.error).toBe("forbidden");
    await session.github("POST", `/users/${a.body.id}/react`, { content: "+1", comment: comment.body.id });
    await session.github("POST", `/users/${a.body.id}/delete`, { comment: comment.body.id });
    expect((await session.github("GET", `/repos/${repo.body.id}/issues/1/comments`)).body).toEqual([]);
  });

  test("a repository the App isn't on, and what isn't built live, are refused before anything reaches GitHub", async () => {
    const stub = githubStub();
    const ana = stub.person("ana-channelstack");
    const session = await liveGitHub(stub).open();
    const person = await session.github("POST", "/users", { login: "ana-channelstack", token: ana.token });
    const before = stub.calls.length;
    const notInstalled = await session.github("POST", "/repos", {});
    expect(notInstalled.body.error).toBe("unsupported_in_live");
    expect(notInstalled.body.message).toContain("hears about every one");
    const push = await session.github("POST", `/users/${person.body.id}/push`, {
      changes: [{ path: "a", content: "" }],
      repo: "1",
      branch: "b",
    });
    expect(push.body.error).toBe("unsupported_in_live");
    expect((await session.github("POST", "/deliveries/x/resend", {})).body.error).toBe("unsupported_in_live");
    expect(stub.calls.length).toBe(before);

    const selected = githubStub();
    selected.selectOnly();
    const other = await liveGitHub(selected).open();
    const fixture = await other.github("GET", "");
    const onSelected = await other.github("POST", "/repos", { apps: [fixture.body.app.id] });
    expect(onSelected.body.error).toBe("live_misconfigured");
    expect(onSelected.body.message).toContain("All repositories");
  });
});

describe("exit check 5.2: GitHub cleanup", () => {
  test("closing the session deletes its repositories, and with them their issues", async () => {
    const stub = githubStub();
    const server = liveGitHub(stub);
    const session = await server.open();
    const fixture = await session.github("GET", "");
    const repo = await session.github("POST", "/repos", { apps: [fixture.body.app.id] });
    await server.call("DELETE", `/sessions/${session.id}`);
    expect(stub.repo(repo.body.name)?.deleted).toBe(true);
    expect(stub.calls.at(-1)).toEqual({
      method: "DELETE",
      path: `/repos/${stub.org}/${repo.body.name}`,
      as: "installation",
    });
  });
});
