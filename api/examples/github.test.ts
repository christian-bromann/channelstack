/**
 * GitHub examples. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos, which live mode doesn't support.
 */
import { describe, test, expect } from "vitest";

describe("issues", () => {
  test("a mention in an issue gets one comment, and no self-trigger loop", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    const issue = await ana.openIssue({ title: "Login fails on Safari", body: "Steps: …" }, { repo });

    await ana.comment("@my-agent can you triage this?", { issue });

    await expect(issue).toHaveCommentFrom(github.app, { text: /triage/i });
    await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
  });

  test("labels and assignment as triggers", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app], labels: ["agent:fix", "bug"] });
    const issue = await ana.openIssue({ title: "Typo in the README" }, { repo });

    await ana.label("agent:fix", { issue });

    await expect(issue).toHaveCommentFrom(github.app, { text: /opened a pull request/i });
    expect(await repo.readFile("README.md", { ref: "my-agent/fix-1" })).not.toContain("teh");
  });

  test("the agent labels and closes what it handled", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app], labels: ["duplicate"] });
    await ana.openIssue({ title: "Dark mode" }, { repo });
    const dupe = await ana.openIssue({ title: "Please add dark mode" }, { repo });

    await ana.comment("@my-agent is this a duplicate?", { issue: dupe });

    await expect(dupe).toHaveLabel("duplicate");
    expect(await dupe.state()).toBe("closed");
  });

  test("no install, no events", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana] }); // app not installed
    const issue = await ana.openIssue({ title: "Hello?" }, { repo });

    const comment = await ana.comment("@my-agent ping", { issue });
    expect(comment.delivery).toBeUndefined();
    await expect(issue).not.toHaveCommentFrom(github.app);

    await repo.installApp(github.app);
    await ana.comment("@my-agent ping again", { issue });
    await expect(issue).toHaveCommentFrom(github.app);
  });
});

describe("pull requests and reviews", () => {
  test("a review request gets a review with inline comments", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
    const pr = await ana.openPullRequest(
      { from: "fix-login", title: "Fix login redirect", changes: { "src/login.ts": "export const redirect = '/home';\n" } },
      { repo },
    );

    await ana.comment("@my-agent review this", { issue: pr });

    await expect(pr).toHaveReviewFrom(github.app, { state: "COMMENTED" });
    await expect(pr).toHaveReviewComment({ path: "src/login.ts", from: github.app });
    await expect(pr).toHaveCommentsFrom(github.app, { count: 1 });
  });

  test("replies in a review thread reach the agent", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
    const pr = await ana.openPullRequest({ from: "feat", changes: { "src/app.ts": "export {}\n" } }, { repo });

    const inline = await ana.reviewComment("@my-agent why is this exported?", { pr, path: "src/app.ts", line: 1 });

    const [answer] = await inline.replies();
    expect(answer?.author.name).toBe(github.app.name);
    await ana.resolve({ comment: inline });
    expect(await inline.resolved()).toBe(true);
  });

  test("a full review round: changes requested, fixed, approved, merged", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const ben = await github.createUser({ login: "ben" });
    const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana, ben], apps: [github.app] });
    const pr = await ana.openPullRequest({ from: "feat", draft: true, changes: { "src/app.ts": "export const x = 1\n" } }, { repo });

    await ana.markReady({ pr });
    await ben.review({
      pr,
      event: "REQUEST_CHANGES",
      body: "@my-agent please address these",
      comments: [{ path: "src/app.ts", line: 1, body: "name this something clearer" }],
    });

    const fix = await pr.headCommit();
    expect(fix.author?.name).toBe(github.app.name);
    await ben.review({ pr, event: "APPROVE" });
    await ana.merge({ pr, method: "squash" });
    await expect(pr).toBeMerged();
  });
});

describe("pushes and check runs", () => {
  test("a push produces a check run with a conclusion", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
    const pr = await ana.openPullRequest({ from: "feat", changes: { "src/app.ts": "export {}\n" } }, { repo });

    const commit = await ana.push({ "src/app.ts": "export const broken = ;\n" }, { repo, branch: "feat", message: "wip" });

    await expect(commit).toHaveCheckRun("my-agent", { conclusion: "failure" });
    const [run] = await commit.checkRuns();
    expect(run?.annotations[0]).toMatchObject({ path: "src/app.ts", level: "failure" });
    await expect(pr).toHaveCheckRun("my-agent", { status: "completed" });
  });

  test("a requested action on a check run", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
    const pr = await ana.openPullRequest({ from: "feat", changes: { "src/app.ts": "export const broken = ;\n" } }, { repo });
    await expect(pr).toHaveCheckRun("my-agent", { conclusion: "action_required" });
    const [run] = await pr.checkRuns();

    await ana.requestAction("autofix", { checkRun: run! });

    await expect(pr).toHaveCheckRun("my-agent", { conclusion: "success", timeout: "20s" });
  });
});

describe("delivery and failures (fake only)", () => {
  test("a redelivered comment doesn't produce a second answer", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    const issue = await ana.openIssue({ title: "Flaky test" }, { repo });
    const comment = await ana.comment("@my-agent investigate", { issue });
    await expect(issue).toHaveCommentFrom(github.app);

    await comment.delivery!.redeliver();

    await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
  });

  test("rejects a webhook with a bad signature", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    const issue = await ana.openIssue({ title: "Anything" }, { repo });
    const comment = await ana.comment("@my-agent hi", { issue });

    await comment.delivery!.resend({ badSignature: true });

    await expect(comment.delivery!).toBeRejected();
  });
});

describe("inspecting what the agent did", () => {
  test("deliveries and API calls", async ({ github }) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    const issue = await ana.openIssue({ title: "Inspect me" }, { repo });
    await ana.comment("@my-agent hello", { issue });

    const [delivery] = await github.deliveries({ type: "issue_comment", resource: repo });
    expect(delivery?.action).toBe("created");
    await expect(delivery!).toBeAccepted();
    await expect(github).toHaveReceivedCall(/POST \/repos\/.+\/issues\/\d+\/comments/, { times: 1 });
  });
});

describe("live mode", () => {
  // With the App's credentials and CHANNELSTACK_GITHUB_USER_ANA_CHANNELSTACK_TOKEN (a machine account's
  // fine-grained PAT) set, this runs in the real test org. GitHub delivers to the agent itself;
  // channelstack creates the repo, acts as Ana and reads the result back.
  test.skipIf(!process.env.CHANNELSTACK_GITHUB_USER_ANA_CHANNELSTACK_TOKEN)("a real comment on a real repo", async ({ github }) => {
    const ana = await github.createUser({ login: "ana-channelstack" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    const issue = await ana.openIssue({ title: "Live smoke test" }, { repo });

    await ana.comment("@my-agent please triage", { issue });

    await expect(issue).toHaveCommentFrom(github.app, { timeout: "60s" });
    // GitHub's delivery log is readable live, so this works too. It shows a delivery a few
    // seconds after GitHub sent it.
    const comments = () => github.deliveries({ type: "issue_comment", resource: repo });
    await expect.poll(async () => (await comments()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const [delivery] = await comments();
    await expect(delivery!).toBeAccepted();
  });
});
