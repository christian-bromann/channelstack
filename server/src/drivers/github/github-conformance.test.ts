import { afterEach, describe, expect, test } from "vitest";

import { githubWorkspace } from "../../../test/github-workspace.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function workspace() {
  const space = await githubWorkspace();
  closers.push(() => {
    space.agent.close();
    // Whatever a test is about, every answer and every webhook in it is what GitHub's schemas describe.
    expect(space.problems.join("\n")).toBe("");
    expect(space.webhookIssues().join("\n")).toBe("");
  });
  return space;
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

// Exit checks 3.2 and 3.3: every response of the fake matches GitHub's REST description, and
// every webhook matches GitHub's webhook schemas.
describe("GitHub's own schemas", () => {
  test("issues: the App's calls and the webhooks people cause", async () => {
    const { h, ana, repo, post, api, path, problems, webhookIssues } = await workspace();
    const issue = await post(`/users/${ana.id}/issues`, {
      issue: { title: "Login fails", body: "Steps" },
      repo: repo.id,
    });
    const ref = { repoId: repo.id, number: issue.number };
    await post(`/users/${ana.id}/comment`, { body: "@my-agent hi", issue: ref });
    await post(`/users/${ana.id}/label`, { labels: ["bug"], issue: ref });
    await post(`/users/${ana.id}/assign`, { assignees: [ana.id], issue: ref });
    await post(`/users/${ana.id}/edit-issue`, { changes: { title: "Login fails on Safari" }, issue: ref });
    await post(`/users/${ana.id}/close`, { issue: ref });
    await post(`/users/${ana.id}/reopen`, { issue: ref });

    await api("GET", path);
    await api("GET", `${path}/issues`);
    await api("GET", `${path}/issues/${issue.number}`);
    const comment = (await api("POST", `${path}/issues/${issue.number}/comments`, { body: "On it" })).body;
    await api("GET", `${path}/issues/${issue.number}/comments`);
    await api("GET", `${path}/issues/comments/${comment.id}`);
    await api("PATCH", `${path}/issues/comments/${comment.id}`, { body: "On it now" });
    await api("POST", `${path}/issues/comments/${comment.id}/reactions`, { content: "eyes" });
    await api("GET", `${path}/issues/comments/${comment.id}/reactions`);
    await api("POST", `${path}/issues/${issue.number}/reactions`, { content: "+1" });
    await api("POST", `${path}/issues/${issue.number}/labels`, { labels: ["duplicate"] });
    await api("GET", `${path}/issues/${issue.number}/labels`);
    await api("DELETE", `${path}/issues/${issue.number}/labels/duplicate`);
    await api("POST", `${path}/issues/${issue.number}/assignees`, { assignees: ["ana"] });
    await api("PATCH", `${path}/issues/${issue.number}`, { state: "closed", state_reason: "not_planned" });
    await api("POST", `${path}/issues`, { title: "From the App", labels: ["bug"] });
    await api("GET", `${path}/labels`);
    await api("POST", `${path}/labels`, { name: "agent:fix", color: "ff0000" });
    await api("DELETE", `${path}/issues/comments/${comment.id}`);
    await api("GET", `${path}/issues/999`);
    await api("POST", `${path}/issues`, {});
    await h.app.settled();

    expect(problems.join("\n")).toBe("");
    expect(webhookIssues().join("\n")).toBe("");
  });

  test("code: contents, the Git Data API, branches and commits", async () => {
    const { h, ana, repo, post, api, path, problems, webhookIssues } = await workspace();
    await post(`/users/${ana.id}/push`, {
      changes: [{ path: "src/app.ts", content: b64("export {}\n") }],
      repo: repo.id,
      branch: "feat",
    });

    const readme = (await api("GET", `${path}/contents/README.md`)).body;
    await api("GET", `${path}/contents/src?ref=feat`);
    await api("GET", `${path}/contents/nope.txt`);
    await api("PUT", `${path}/contents/README.md`, {
      message: "Fix typo",
      content: b64("# fixed\n"),
      sha: readme.sha,
      branch: "feat",
    });
    await api("PUT", `${path}/contents/docs/new.md`, { message: "Add docs", content: b64("new\n"), branch: "feat" });
    await api("GET", `${path}/branches`);
    await api("GET", `${path}/branches/feat`);
    const commits = (await api("GET", `${path}/commits?sha=feat`)).body;
    await api("GET", `${path}/commits/${commits[0].sha}`);
    await api("GET", `${path}/compare/main...feat`);
    const ref = (await api("GET", `${path}/git/ref/heads/main`)).body;
    const blob = (await api("POST", `${path}/git/blobs`, { content: "hello\n", encoding: "utf-8" })).body;
    await api("GET", `${path}/git/blobs/${blob.sha}`);
    const base = (await api("GET", `${path}/git/commits/${ref.object.sha}`)).body;
    const tree = (
      await api("POST", `${path}/git/trees`, {
        base_tree: base.tree.sha,
        tree: [{ path: "hello.txt", mode: "100644", type: "blob", sha: blob.sha }],
      })
    ).body;
    await api("GET", `${path}/git/trees/${tree.sha}?recursive=1`);
    const commit = (
      await api("POST", `${path}/git/commits`, { message: "Say hello", tree: tree.sha, parents: [ref.object.sha] })
    ).body;
    await api("POST", `${path}/git/refs`, { ref: "refs/heads/my-agent/hello", sha: commit.sha });
    await api("PATCH", `${path}/git/refs/heads/my-agent/hello`, { sha: commit.sha });
    await api("GET", `${path}/git/matching-refs/heads/my-agent`);
    await api("DELETE", `${path}/git/refs/heads/my-agent/hello`);
    await h.app.settled();

    expect(problems.join("\n")).toBe("");
    expect(webhookIssues().join("\n")).toBe("");
  });

  test("pull requests, reviews and checks", async () => {
    const { h, ana, repo, post, api, path, problems, webhookIssues } = await workspace();
    const ben = await post("/users", { login: "ben" });
    const pr = await post(`/users/${ana.id}/pulls`, {
      pr: {
        from: "feat",
        title: "Add app",
        changes: [{ path: "src/app.ts", content: b64("export const x = 1\n") }],
        draft: true,
      },
      repo: repo.id,
    });
    const ref = { repoId: repo.id, number: pr.number };
    await post(`/users/${ana.id}/mark-ready`, { pr: ref });
    await post(`/users/${ana.id}/request-review`, { reviewers: [ben.id], pr: ref });
    const review = await post(`/users/${ben.id}/review`, {
      review: {
        pr: ref,
        event: "REQUEST_CHANGES",
        body: "Please fix",
        comments: [{ path: "src/app.ts", line: 1, body: "name it" }],
      },
    });
    const inline = await post(`/users/${ana.id}/review-comment`, {
      body: "why?",
      pr: ref,
      path: "src/app.ts",
      line: 1,
    });
    await post(`/users/${ana.id}/resolve`, { comment: inline.id });
    await post(`/users/${ana.id}/unresolve`, { comment: inline.id });

    await api("GET", `${path}/pulls`);
    const pull = (await api("GET", `${path}/pulls/${pr.number}`)).body;
    await api("GET", `${path}/pulls/${pr.number}/files`);
    await api("GET", `${path}/pulls/${pr.number}/commits`);
    await api("GET", `${path}/pulls/${pr.number}/reviews`);
    await api("GET", `${path}/pulls/${pr.number}/reviews/${review.id}`);
    await api("GET", `${path}/pulls/${pr.number}/reviews/${review.id}/comments`);
    await api("GET", `${path}/pulls/${pr.number}/comments`);
    await api("GET", `${path}/pulls/${pr.number}/requested_reviewers`);
    await api("POST", `${path}/pulls/${pr.number}/comments/${inline.id}/replies`, { body: "Because" });
    await api("POST", `${path}/pulls/${pr.number}/comments`, {
      body: "And this",
      path: "src/app.ts",
      line: 1,
      side: "RIGHT",
      commit_id: pull.head.sha,
    });
    await api("GET", `${path}/pulls/comments/${inline.id}`);
    await api("POST", `${path}/pulls/comments/${inline.id}/reactions`, { content: "rocket" });
    await api("POST", `${path}/pulls/${pr.number}/reviews`, {
      event: "COMMENT",
      body: "Looks fine",
      comments: [{ path: "src/app.ts", line: 1, body: "nit" }],
    });
    await api("POST", `${path}/pulls/${pr.number}/reviews`, {
      event: "COMMENT",
      comments: [{ path: "src/app.ts", line: 99, body: "no" }],
    });
    await api("PATCH", `${path}/pulls/${pr.number}`, { title: "Add the app" });

    const run = (
      await api("POST", `${path}/check-runs`, { name: "my-agent", head_sha: pull.head.sha, status: "in_progress" })
    ).body;
    await api("PATCH", `${path}/check-runs/${run.id}`, {
      conclusion: "action_required",
      output: {
        title: "1 problem",
        summary: "A syntax error",
        annotations: [
          { path: "src/app.ts", start_line: 1, end_line: 1, annotation_level: "failure", message: "Unexpected token" },
        ],
      },
      actions: [{ label: "Fix", description: "Fix it", identifier: "autofix" }],
    });
    await api("GET", `${path}/check-runs/${run.id}`);
    await api("GET", `${path}/check-runs/${run.id}/annotations`);
    await api("GET", `${path}/commits/${pull.head.sha}/check-runs`);
    await api("POST", `${path}/statuses/${pull.head.sha}`, { state: "success", context: "ci/test" });
    await api("GET", `${path}/commits/${pull.head.sha}/statuses`);
    await api("GET", `${path}/commits/${pull.head.sha}/status`);
    await post(`/users/${ana.id}/rerun`, { checkRun: run.id });
    await post(`/users/${ana.id}/request-action`, { identifier: "autofix", checkRun: run.id });

    await post(`/users/${ana.id}/push`, {
      changes: [{ path: "src/app.ts", content: b64("export const count = 1\n") }],
      repo: repo.id,
      branch: "feat",
    });
    await post(`/users/${ben.id}/review`, { review: { pr: ref, event: "APPROVE" } });
    await api("GET", `${path}/pulls/${pr.number}/merge`);
    await api("PUT", `${path}/pulls/${pr.number}/merge`, { merge_method: "squash" });
    await api("GET", `${path}/pulls/${pr.number}/merge`);
    await h.app.settled();

    expect(problems.join("\n")).toBe("");
    expect(webhookIssues().join("\n")).toBe("");
  });

  test("the App's own endpoints, people, and the routes the scenarios above leave out", async () => {
    const { h, ana, repo, post, api, asApp, path, problems, webhookIssues } = await workspace();
    await post("/users", { login: "ben" });
    await post(`/users/${ana.id}/push`, {
      changes: [{ path: "src/app.ts", content: b64("export {}\n") }],
      repo: repo.id,
      branch: "feat",
    });
    const issue = await post(`/users/${ana.id}/issues`, { issue: { title: "Labels" }, repo: repo.id });
    const comment = await post(`/users/${ana.id}/comment`, {
      body: "@my-agent hi",
      issue: { repoId: repo.id, number: issue.number },
    });
    await h.app.settled();

    await asApp("GET", "/app");
    const [installation] = (await asApp("GET", "/app/installations")).body;
    await asApp("GET", `/app/installations/${installation.id}`);
    await asApp("GET", "/app/installations/1");
    await asApp("POST", `/app/installations/${installation.id}/access_tokens`);
    await asApp("POST", "/app/installations/1/access_tokens");
    await asApp("GET", `${path}/installation`);
    await asApp("GET", "/orgs/acme/installation");
    const [delivery] = (await asApp("GET", "/app/hook/deliveries")).body;
    await asApp("GET", `/app/hook/deliveries/${delivery.id}`);
    await asApp("GET", "/app/hook/deliveries/1");
    await asApp("POST", `/app/hook/deliveries/${delivery.id}/attempts`);
    await asApp("POST", "/app/hook/deliveries/1/attempts");
    await api("GET", "/installation/repositories");
    await api("GET", "/users/ana");
    await api("GET", "/users/my-agent%5Bbot%5D");
    await api("GET", "/users/nobody");
    await api("GET", "/user");
    await api("GET", `${path}/collaborators/ana/permission`);
    await api("GET", `${path}/collaborators/ben/permission`);
    await api("GET", `${path}/collaborators/nobody/permission`);

    await api("GET", `${path}/labels/bug`);
    await api("PUT", `${path}/issues/${issue.number}/labels`, { labels: ["bug", "question"] });
    await api("DELETE", `${path}/issues/${issue.number}/labels`);
    await api("POST", `${path}/issues/${issue.number}/assignees`, { assignees: ["ana", "ben"] });
    await api("DELETE", `${path}/issues/${issue.number}/assignees`, { assignees: ["ben"] });
    const reaction = (await api("POST", `${path}/issues/comments/${comment.id}/reactions`, { content: "eyes" })).body;
    await api("DELETE", `${path}/issues/comments/${comment.id}/reactions/${reaction.id}`);
    const onIssue = (await api("POST", `${path}/issues/${issue.number}/reactions`, { content: "heart" })).body;
    await api("GET", `${path}/issues/${issue.number}/reactions`);
    await api("DELETE", `${path}/issues/${issue.number}/reactions/${onIssue.id}`);

    const pull = (await api("POST", `${path}/pulls`, { head: "feat", base: "main", title: "From the App" })).body;
    await api("POST", `${path}/pulls/${pull.number}/requested_reviewers`, { reviewers: ["ben"] });
    await api("POST", `${path}/pulls/${pull.number}/requested_reviewers`, { reviewers: ["my-agent[bot]"] });
    const pending = (await api("POST", `${path}/pulls/${pull.number}/reviews`, { body: "Thinking" })).body;
    await api("POST", `${path}/pulls/${pull.number}/reviews/${pending.id}/events`, { event: "COMMENT" });
    await api("POST", `${path}/pulls/${pull.number}/reviews/${pending.id}/events`, { event: "COMMENT" });
    const inline = (
      await api("POST", `${path}/pulls/${pull.number}/comments`, {
        body: "Here",
        path: "src/app.ts",
        line: 1,
        commit_id: pull.head.sha,
      })
    ).body;
    await api("PATCH", `${path}/pulls/comments/${inline.id}`, { body: "Here, exactly" });
    const onDiff = (await api("POST", `${path}/pulls/comments/${inline.id}/reactions`, { content: "+1" })).body;
    await api("GET", `${path}/pulls/comments/${inline.id}/reactions`);
    await api("DELETE", `${path}/pulls/comments/${inline.id}/reactions/${onDiff.id}`);
    await api("DELETE", `${path}/pulls/comments/${inline.id}`);
    await api("PATCH", `${path}/pulls/${pull.number}`, { state: "closed" });

    const file = (await api("GET", `${path}/contents/src/app.ts?ref=feat`)).body;
    await api("DELETE", `${path}/contents/src/app.ts`, { message: "Remove it", sha: file.sha, branch: "feat" });
    await api("DELETE", `${path}/contents/src/app.ts`, { message: "Again", sha: file.sha, branch: "feat" });
    await h.app.settled();

    expect(problems.join("\n")).toBe("");
    expect(webhookIssues().join("\n")).toBe("");
  });
});
