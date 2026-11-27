/**
 * Linear examples. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos, which live mode doesn't support.
 */
import { describe, expect, test } from "vitest";

describe("delegation and agent sessions", () => {
  test("delegating an issue opens one session with a first thought", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });

    const session = await ana.delegate(linear.app, { issue });

    await expect(session).toHaveActivity({ type: "thought" }, { timeout: "10s" });
    await expect(issue).toBeDelegatedTo(linear.app);
    expect(await issue.sessions()).toHaveLength(1);
  });

  test("creating an issue already delegated", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });

    const issue = await ana.createIssue(
      { title: "Bump the Node version", delegate: linear.app, priority: 3 },
      { team },
    );

    const session = await issue.session();
    await expect(session).toHaveSessionState("active");
  });

  test("a mention in a comment opens a session", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Flaky e2e test" }, { team });

    const comment = await ana.comment("@my-agent can you take a look?", { issue });

    expect(comment.session).toBeDefined();
    await expect(comment.session!).toHaveActivity({ type: "response" });
  });

  test("the session ends as complete, never stuck as active", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Rename the env var", delegate: linear.app }, { team });

    const session = await issue.session();
    await session.waitForState(["complete", "error"], { timeout: "30s" });

    await expect(issue).toHaveSessionState("complete");
    await expect(session).toHaveActivity({ type: "response", text: /renamed/i });
  });

  test("the agent shows a plan and links its work", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Add rate limiting to the API", delegate: linear.app }, { team });
    const session = await issue.session();

    await expect(session).toHaveActivity({ type: "action" });
    const plan = await session.plan();
    expect(plan.length).toBeGreaterThan(0);
    const links = await session.externalUrls();
    expect(links.map((l) => l.url)).toContainEqual(expect.stringContaining("github.com"));
  });
});

describe("conversation inside a session", () => {
  test("the agent asks a question and continues after the answer", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Fix the login bug" }, { team });
    const session = await ana.delegate(linear.app, { issue });

    const question = await session.waitForActivity({ type: "elicitation" });
    await expect(issue).toHaveSessionState("awaitingInput");
    await ana.answer("Only Safari 18", { elicitation: question });

    await expect(session).toHaveActivity({ type: "response", text: /safari 18/i });
  });

  test("a follow-up prompt gets one response", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Write the migration", delegate: linear.app }, { team });
    const session = await issue.session();
    await session.waitForState("complete");

    await ana.prompt("also update the docs", { session });

    const response = await session.waitForActivity({ type: "response" });
    expect(response.body).toMatch(/docs/i);
  });

  test("Stop ends the session", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Refactor billing", delegate: linear.app }, { team });
    const session = await issue.session();
    await expect(session).toHaveActivity({ type: "thought" });

    await ana.stop({ session });

    await expect(session).toHaveSessionState("complete");
  });

  test("taking the issue back", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Small fix", delegate: linear.app }, { team });

    await ana.undelegate({ issue });

    await expect(issue).toBeDelegatedTo(undefined);
  });
});

describe("issue workflow", () => {
  test("the agent moves the issue through its states", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Update the changelog", state: "Todo" }, { team });

    await ana.delegate(linear.app, { issue });

    await expect(issue).toHaveState("In Progress");
    await expect(issue).toHaveState("In Review", { timeout: "30s" });
  });

  test("custom workflow states and labels", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({
      key: "OPS",
      members: [ana],
      labels: ["incident"],
      states: [
        { name: "Triage", type: "triage" },
        { name: "Investigating", type: "started" },
        { name: "Resolved", type: "completed" },
      ],
    });
    const issue = await ana.createIssue({ title: "API latency spike", labels: ["incident"] }, { team });

    await ana.comment("@my-agent investigate", { issue });

    await expect(issue).toHaveState("Investigating");
    await expect(issue).toHaveCommentFrom(linear.app);
  });
});

// A session's `delivery` is there in the fake only: live, Linear delivers to the agent itself.
describe("delivery and failures (fake only)", () => {
  test("a redelivered webhook doesn't duplicate activities", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Anything" }, { team });
    const session = await ana.delegate(linear.app, { issue });
    await expect(session).toHaveActivity({ type: "thought" });
    const before = (await session.activities()).length;

    await session.delivery!.redeliver();

    await expect(issue).toHaveSessionState("complete");
    const thoughts = (await session.activities()).filter((a) => a.type === "thought");
    expect(thoughts.length).toBeLessThanOrEqual(before);
  });

  test("rejects a stale webhook", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Anything" }, { team });
    const session = await ana.delegate(linear.app, { issue });

    await session.delivery!.resend({ stale: true });

    await expect(session.delivery!).toBeRejected();
  });
});

describe("inspecting what the agent did", () => {
  test("GraphQL operations the agent sent", async ({ linear }) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title: "Inspect me" }, { team });
    await ana.delegate(linear.app, { issue });

    await expect(linear).toHaveReceivedCall("agentActivityCreate");
    const errors = await linear.calls({ error: true });
    expect(errors).toEqual([]);
  });
});

describe("live mode", () => {
  // With the OAuth app's token and CHANNELSTACK_LINEAR_USER_ANA_TOKEN (Ana's personal API key) set,
  // this runs in the real test workspace. Linear delivers to the agent itself.
  test.skipIf(!process.env.CHANNELSTACK_LINEAR_USER_ANA_TOKEN)(
    "a real delegation in the real workspace",
    async ({ linear }) => {
      const ana = await linear.createUser({ name: "Ana" });
      const team = await linear.createTeam({ members: [ana] });
      const issue = await ana.createIssue({ title: "Live smoke test" }, { team });

      const session = await ana.delegate(linear.app, { issue });

      await expect(session).toHaveActivity({ type: "thought" }, { timeout: "30s" });
    },
  );
});
