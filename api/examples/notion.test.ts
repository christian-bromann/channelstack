/**
 * Notion examples. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos, or features not yet supported live.
 */
import { describe, test, expect } from "vitest";

describe("comments and discussions", () => {
  test("a mention in a page comment gets a reply in the same discussion", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Roadmap", content: "# Q1\n- ship search\n- ship billing", connections: [notion.app] });

    const comment = await ana.comment("@my-agent summarize this page", { page });

    await expect(comment.discussion).toHaveCommentFrom("my-agent", { text: /search/i });
    await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
  });

  test("a comment anchored to a block", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Spec", content: "## Rate limits\n100 req/min per token", connections: [notion.app] });

    const comment = await ana.comment("@my-agent is this enough for the mobile app?", { page, anchor: "Rate limits" });

    expect(comment.discussion.anchor).toContain("Rate limits");
    await expect(comment.discussion).toHaveCommentFrom(notion.app);
  });

  test("a reply in the discussion continues the conversation", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Retro", content: "- deploys were slow", connections: [notion.app] });
    const comment = await ana.comment("@my-agent what went wrong?", { page });
    await comment.discussion.waitForComment({ from: notion.app });

    await ana.reply("@my-agent and what should we change?", { discussion: comment.discussion });

    const answer = await comment.discussion.waitForComment({ from: notion.app });
    expect(answer.text).toMatch(/deploy/i);
  });

  test("it ignores its own comments", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Notes", connections: [notion.app] });

    const comment = await ana.comment("@my-agent say hi", { page });

    await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1, quietFor: "2s" });
  });
});

describe("connections", () => {
  test("pages the integration isn't connected to stay silent", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Private notes" }); // not connected

    const comment = await ana.comment("@my-agent read this", { page });

    expect(comment.delivery).toBeUndefined();
    await expect(comment.discussion).not.toHaveCommentFrom(notion.app);
  });

  test("child pages inherit the parent's connection", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const space = await notion.createPage({ title: "Engineering", connections: [notion.app] });
    const child = await notion.createPage({ title: "On-call", parent: space });

    const comment = await ana.comment("@my-agent who's on call?", { page: child });

    await expect(comment.discussion).toHaveCommentFrom(notion.app);
  });

  test("connecting later", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Ideas" });

    await ana.connect(notion.app, { page });

    expect(await page.connections()).toContainEqual(expect.objectContaining({ name: notion.app.name }));
  });
});

describe("pages and databases", () => {
  test("the agent edits the page it was asked about", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Meeting notes", content: "- talked about Q1", connections: [notion.app] });

    await ana.comment("@my-agent add action items at the end", { page });

    await expect(page).toHaveBlock(/action items/i);
    expect(await page.markdown()).toMatch(/- \[ \]/);
  });

  test("a mention inside the page body", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Draft", content: "## Intro\nTODO", connections: [notion.app] });

    await ana.mention(notion.app, { page, inBlock: "TODO" });

    await expect(page).toHaveBlock(/intro/i);
    expect(await page.markdown()).not.toContain("TODO");
  });

  test("a person creates a page and the agent picks it up", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const space = await notion.createPage({ title: "Incidents", connections: [notion.app] });

    const report = await ana.createPage({ title: "Checkout outage", parent: space, content: "Started 09:12 UTC" });

    await expect(report).toHaveBlock(/summary/i, { timeout: "20s" });
  });

  test("database rows: the agent fills in a property", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const tasks = await notion.createDatabase({
      title: "Tasks",
      properties: { Name: "title", Status: { status: ["Todo", "In progress", "Done"] }, Estimate: "number" },
      connections: [notion.app],
    });

    const row = await ana.addRow({ Name: "Migrate to Postgres 17", Status: "Todo" }, { database: tasks });
    await ana.comment("@my-agent estimate this", { page: row });

    await expect(row).toHavePropertyValue("Estimate", expect.any(Number));
  });

  test("a property change as a trigger", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const tasks = await notion.createDatabase({
      title: "Tasks",
      properties: { Name: "title", Status: { status: ["Todo", "Ready for agent", "Done"] } },
      rows: [{ Name: "Write the onboarding guide", Status: "Todo" }],
      connections: [notion.app],
    });
    const [row] = await tasks.rows({ Name: "Write the onboarding guide" });

    await ana.setProperty("Status", "Ready for agent", { page: row! });

    await expect(row!).toHavePropertyValue("Status", "Done", { timeout: "30s" });
  });
});

describe("delivery and failures (fake only)", () => {
  test("rejects a webhook with a bad signature", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Anything", connections: [notion.app] });
    const comment = await ana.comment("@my-agent hi", { page });

    await comment.delivery!.resend({ badSignature: true });

    await expect(comment.delivery!).toBeRejected();
  });

  test("a redelivered comment doesn't produce a second answer", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Anything", connections: [notion.app] });
    const comment = await ana.comment("@my-agent hi", { page });
    await expect(comment.discussion).toHaveCommentFrom(notion.app);

    // Notion retries with the same event id.
    await comment.delivery!.redeliver();

    await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
  });

  test("resolving a discussion (not yet supported live)", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Review", connections: [notion.app] });
    const comment = await ana.comment("@my-agent check the numbers", { page });
    await comment.discussion.waitForComment({ from: notion.app });

    await ana.resolve({ discussion: comment.discussion });

    expect(await comment.discussion.resolved()).toBe(true);
    await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
  });
});

describe("live mode", () => {
  // With the integration token and CHANNELSTACK_NOTION_USER_ANA_TOKEN (Ana's personal access
  // token) set, this runs in the real test workspace, under a parent page the integration
  // is connected to. Notion delivers to the agent itself.
  test.skipIf(!process.env.CHANNELSTACK_NOTION_USER_ANA_TOKEN)("a real comment on a real page", async ({ notion }) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Live smoke test", connections: [notion.app] });

    const comment = await ana.comment("@my-agent summarize this page", { page });

    await expect(comment.discussion).toHaveCommentFrom(notion.app, { timeout: "60s" });
  });
});
