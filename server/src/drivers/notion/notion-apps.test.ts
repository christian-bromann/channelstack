/**
 * Exit check 12.3 for Notion: several integrations in one workspace (decision 0027). Each has its
 * own bot user, token and webhook subscription, sees only the pages connected to it, and hears
 * what the other integrations change there as Notion sends it: `page.*` and `comment.*` events
 * with `authors: [{ type: "bot" }]`, one delivery per integration, each signed with its own
 * verification token. Whether Notion does send them, and how it refuses a mention of a bot, is
 * still to confirm (B7); the fake does what the decision says until then.
 */
import notionClient from "@notionhq/client";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal } from "../../../test/app-harness.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";

// The package is CommonJS: Node gives it to an ES module as its default export.
const { verifyWebhookSignature } = notionClient;

const VERSION: Record<string, string> = { "notion-version": "2025-09-03" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/** A workspace with my-agent at one endpoint and `writer` at another, and Ana. */
async function twoIntegrations() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  agents.push(mine, theirs);
  const h = harness(
    { notion: mine.url },
    { appWebhooks: (_driver, app) => (app === "writer" ? theirs.url : undefined) },
  );
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/notion`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const { app } = await get("");
  const writer = await post("/apps", { name: "writer" });
  const ana = await post("/users", { name: "Ana" });
  /** The REST API, as an integration calls it with its own token. */
  const api = (token: string, method: string, path: string, body?: unknown) =>
    h.provider(method, `notion/v1/${path}`, body, token, VERSION);
  return { h, sessionId: sessionId as string, mine, theirs, base, post, get, app, writer, ana, api };
}

const events = (agent: RecordingAgent) =>
  agent.received.map((delivery) => JSON.parse(delivery.body) as Record<string, any>);

describe("exit check 12.3: Notion integrations", () => {
  test("an integration has its own bot user, token and verification token, and the same name gives the same one", async () => {
    const { h, post, get, app, writer } = await twoIntegrations();
    expect(writer).toMatchObject({ name: "writer", kind: "app", channel: "notion", botUserId: writer.id });
    expect(writer.id).toMatch(UUID);
    expect(writer.token).toMatch(/^ntn_/);
    expect(writer.webhookSecret).toMatch(/^secret_/);
    for (const key of ["id", "token", "webhookSecret"]) expect(writer[key]).not.toBe(app[key]);
    expect(writer.token).toBe(h.secrets.forApp("notion", "writer", "token"));
    expect(writer.webhookSecret).toBe(h.secrets.forApp("notion", "writer", "verificationToken"));
    expect(await post("/apps", { name: "writer" })).toEqual(writer);
    expect((await get("/apps")).map((one: { name: string }) => one.name)).toEqual(["my-agent", "writer"]);
    expect(await refusal(post("/apps", { name: "writer", capabilities: ["read_content"] }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "Writer_2" }))).toBe("invalid_argument");
  });

  test("each token answers as its own integration, and sees only the pages connected to it", async () => {
    const { post, get, app, writer, api } = await twoIntegrations();
    expect((await api(writer.token, "GET", "users/me")).body).toMatchObject({
      object: "user",
      id: writer.id,
      type: "bot",
      name: "writer",
    });
    expect((await api(app.token, "GET", "users/me")).body).toMatchObject({ id: app.id, name: "my-agent" });
    const listed = (await api(app.token, "GET", "users")).body.results.filter(
      (user: { type: string }) => user.type === "bot",
    );
    expect(listed.map((user: { id: string }) => user.id)).toEqual([app.id, writer.id]);

    const mineOnly = await post("/pages", { title: "Mine", connections: [app.id] });
    expect((await api(writer.token, "GET", `pages/${mineOnly.id}`)).body).toMatchObject({
      status: 404,
      code: "object_not_found",
    });
    expect((await api(app.token, "GET", `pages/${mineOnly.id}`)).status).toBe(200);

    const shared = await post("/pages", { title: "Shared", connections: [app.id, writer.id] });
    const child = await post("/pages", { title: "Under it", parent: shared.id });
    // A connection is inherited by the pages under it, for any integration.
    expect((await api(writer.token, "GET", `pages/${child.id}`)).status).toBe(200);
    expect((await get(`/pages/${child.id}/connections`)).map((one: { name: string }) => one.name)).toEqual([
      "my-agent",
      "writer",
    ]);
    const searched = (await api(writer.token, "POST", "search", { query: "" })).body.results.map(
      (result: { id: string }) => result.id,
    );
    expect(searched).toEqual(expect.arrayContaining([shared.id, child.id]));
    expect(searched).not.toContain(mineOnly.id);

    const database = await post("/databases", {
      title: "Tasks",
      properties: { Name: "title" },
      rows: [{ Name: "One" }],
      connections: [writer.id],
    });
    expect((await api(writer.token, "GET", `databases/${database.id}`)).status).toBe(200);
    expect((await api(app.token, "GET", `databases/${database.id}`)).status).toBe(404);

    // A person connects another integration to a page, and takes it away again.
    await post(`/users/${(await post("/users", { name: "Bo" })).id}/connect`, {
      integration: writer.id,
      page: mineOnly.id,
    });
    expect((await api(writer.token, "GET", `pages/${mineOnly.id}`)).status).toBe(200);
  });

  test("another integration's comment reaches every connected integration, and itself, each signed for that integration alone (A1)", async () => {
    const { h, mine, theirs, post, app, writer, api } = await twoIntegrations();
    const page = await post("/pages", { title: "Roadmap", connections: [app.id, writer.id] });

    const created = await api(writer.token, "POST", "comments", {
      parent: { page_id: page.id },
      rich_text: [{ type: "text", text: { content: "Drafted the summary" } }],
    });
    await h.app.settled();

    expect(created.body).toMatchObject({
      object: "comment",
      created_by: { id: writer.id },
      display_name: { type: "integration", resolved_name: "writer" },
    });
    const [heard] = events(mine);
    const [own] = events(theirs);
    for (const event of [heard, own]) {
      expect(event).toMatchObject({
        type: "comment.created",
        entity: { id: created.body.id, type: "comment" },
        authors: [{ id: writer.id, type: "bot" }],
        data: { page_id: page.id },
      });
    }
    // Each delivery names the integration it went to, through its own subscription.
    expect(heard?.accessible_by).toEqual([{ id: app.id, type: "bot" }]);
    expect(own?.accessible_by).toEqual([{ id: writer.id, type: "bot" }]);
    expect(heard?.integration_id).not.toBe(own?.integration_id);
    expect(heard?.subscription_id).not.toBe(own?.subscription_id);
    expect(heard?.id).not.toBe(own?.id);

    // Each integration's receiver accepts its own delivery and rejects the other's.
    const verifies = (agent: RecordingAgent, verificationToken: string) =>
      Promise.all(
        agent.received.map((delivery) =>
          verifyWebhookSignature({
            body: delivery.body,
            signature: String(delivery.headers["x-notion-signature"]),
            verificationToken,
          }),
        ),
      );
    expect(await verifies(mine, app.webhookSecret)).toEqual([true]);
    expect(await verifies(mine, writer.webhookSecret)).toEqual([false]);
    expect(await verifies(theirs, writer.webhookSecret)).toEqual([true]);
    expect(await verifies(theirs, app.webhookSecret)).toEqual([false]);
  });

  test("another integration's page changes: page.created, page.properties_updated, and content updates batched as a person's", async () => {
    const { h, mine, theirs, post, app, writer, api } = await twoIntegrations();
    const space = await post("/pages", { title: "Space", connections: [app.id, writer.id] });

    const page = (
      await api(writer.token, "POST", "pages", {
        parent: { page_id: space.id },
        properties: { title: { title: [{ text: { content: "Notes" } }] } },
      })
    ).body;
    await h.app.settled();
    expect(events(mine).map((event) => event.type)).toEqual(["page.created"]);
    expect(events(mine)[0]).toMatchObject({ entity: { id: page.id }, authors: [{ id: writer.id, type: "bot" }] });
    expect(events(theirs).map((event) => event.type)).toEqual(["page.created"]);

    const paragraph = (content: string) => ({ type: "paragraph", paragraph: { rich_text: [{ text: { content } }] } });
    await api(writer.token, "PATCH", `blocks/${page.id}/children`, { children: [paragraph("one")] });
    await api(writer.token, "PATCH", `blocks/${page.id}/children`, { children: [paragraph("two")] });
    await api(writer.token, "PATCH", `pages/${page.id}`, {
      properties: { title: { title: [{ text: { content: "Notes, final" } }] } },
    });
    await h.app.settled();
    h.timers.advance(1000);
    await h.app.settled();

    for (const agent of [mine, theirs]) {
      const types = events(agent).map((event) => event.type);
      expect(types).toEqual(["page.created", "page.properties_updated", "page.content_updated"]);
      const batched = events(agent).find((event) => event.type === "page.content_updated");
      expect(batched?.data.updated_blocks).toHaveLength(2);
      expect(batched?.authors).toEqual([{ id: writer.id, type: "bot" }]);
    }
  });

  test("a person's comment is one delivery per integration connected to the page, and none for one that isn't", async () => {
    const { h, mine, theirs, post, get, app, writer, ana } = await twoIntegrations();
    const shared = await post("/pages", { title: "Shared", connections: [app.id, writer.id] });
    const mineOnly = await post("/pages", { title: "Mine", connections: [app.id] });

    const comment = await post(`/users/${ana.id}/comment`, { text: "@writer please draft", page: shared.id });
    await post(`/users/${ana.id}/comment`, { text: "just for my-agent", page: mineOnly.id });
    await h.app.settled();

    // A person may mention any integration; the mention carries its bot.
    expect(comment.text).toBe("@writer please draft");
    expect(events(mine)).toHaveLength(2);
    expect(events(theirs)).toHaveLength(1);
    expect(events(theirs)[0]).toMatchObject({ type: "comment.created", authors: [{ id: ana.id, type: "person" }] });
    // The comment's delivery is the built-in integration's; every delivery says which integration it went to.
    expect(comment.delivery).toMatchObject({ app: "my-agent", type: "comment.created" });
    const deliveries = (await get("/deliveries")) as Array<{ app: string; entity: { id: string } }>;
    expect(deliveries.filter((one) => one.entity.id === comment.id).map((one) => one.app)).toEqual([
      "my-agent",
      "writer",
    ]);
  });

  test("an integration can't mention another integration's bot: validation_error", async () => {
    const { post, app, writer, ana, api } = await twoIntegrations();
    const page = await post("/pages", { title: "Handoff", connections: [app.id, writer.id] });

    const mention = (id: string) => ({ type: "mention", mention: { user: { id } } });
    const refused = await api(writer.token, "POST", "comments", {
      parent: { page_id: page.id },
      rich_text: [mention(app.id), { type: "text", text: { content: " please review" } }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ object: "error", code: "validation_error" });
    const inBlock = await api(writer.token, "PATCH", `blocks/${page.id}/children`, {
      children: [{ type: "paragraph", paragraph: { rich_text: [mention(app.id)] } }],
    });
    expect(inBlock.body.code).toBe("validation_error");
    // A person it may mention.
    expect(
      (await api(writer.token, "POST", "comments", { parent: { page_id: page.id }, rich_text: [mention(ana.id)] }))
        .status,
    ).toBe(200);
    // So may a scripted integration's text: a person, not a bot.
    expect(await refusal(post(`/apps/${writer.id}/comment`, { text: "@my-agent take it", page: page.id }))).toBe(
      "validation_error",
    );
    expect((await post(`/apps/${writer.id}/comment`, { text: "@Ana have a look", page: page.id })).text).toBe(
      "@Ana have a look",
    );
  });

  test("each subscription has its own verification handshake", async () => {
    const { h, mine, theirs, post, writer } = await twoIntegrations();
    const sent = await post("/verification", { app: writer.id });
    await h.app.settled();
    expect(sent).toMatchObject({ app: "writer", type: "verification", payload: { verification_token: "[redacted]" } });
    expect(JSON.parse(theirs.received[0]?.body ?? "{}")).toEqual({ verification_token: writer.webhookSecret });
    expect(mine.received).toEqual([]);
  });

  test("a scripted integration comments, replies, edits and renames as its own calls would; never as my-agent", async () => {
    const { h, mine, post, get, app, writer, ana } = await twoIntegrations();
    const page = await post("/pages", { title: "Plan", content: "## Goals", connections: [app.id, writer.id] });
    const elsewhere = await post("/pages", { title: "Private", connections: [app.id] });

    const comment = await post(`/apps/${writer.id}/comment`, { text: "Drafted it", page: page.id });
    const reply = await post(`/apps/${writer.id}/reply`, { text: "Details", discussion: comment.discussion.id });
    await post(`/apps/${writer.id}/edit`, { change: { append: "Ship it" }, page: page.id });
    const renamed = await post(`/apps/${writer.id}/rename`, { title: "Plan v2", page: page.id });
    h.timers.advance(1000);
    await h.app.settled();

    expect(comment.author).toMatchObject({ kind: "app", name: "writer", id: writer.id });
    expect(reply.discussion.id).toBe(comment.discussion.id);
    expect(comment.delivery).toMatchObject({ app: "my-agent", type: "comment.created" });
    expect(renamed).toMatchObject({ app: "my-agent", type: "page.properties_updated" });
    expect(events(mine).map((event) => event.type)).toEqual([
      "comment.created",
      "comment.created",
      "page.properties_updated",
      "page.content_updated",
    ]);
    for (const event of events(mine)) expect(event.authors).toEqual([{ id: writer.id, type: "bot" }]);
    expect(await get(`/pages/${page.id}/markdown`)).toBe("## Goals\nShip it");
    expect((await get(`/pages/${page.id}/transcript`)).text).toContain("writer: Drafted it");

    // Only where it is connected, only with its capabilities, and never as the built-in integration.
    expect(await refusal(post(`/apps/${writer.id}/comment`, { text: "hi", page: elsewhere.id }))).toBe(
      "object_not_found",
    );
    const reader = await post("/apps", { name: "reader", capabilities: ["read_content", "read_comments"] });
    await post(`/users/${ana.id}/connect`, { integration: reader.id, page: page.id });
    expect(await refusal(post(`/apps/${reader.id}/comment`, { text: "hi", page: page.id }))).toBe(
      "restricted_resource",
    );
    expect(await refusal(post(`/apps/${app.id}/comment`, { text: "hi", page: page.id }))).toBe("invalid_argument");
    expect(await refusal(post("/apps/my-agent/reply", { text: "hi", discussion: comment.discussion.id }))).toBe(
      "invalid_argument",
    );
  });

  test("exit check 12.6: integrations commenting at each other on a page are stopped at the guard's limit, their page writes too, and the session says so", async () => {
    const { h, sessionId, mine, post, app, writer, ana, api } = await twoIntegrations();
    const page = await post("/pages", { title: "Roadmap", connections: [app.id, writer.id] });
    await post(`/users/${ana.id}/comment`, { text: "go", page: page.id });
    // Page-level comments: each starts a discussion of its own, and all of them count on the page.
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      const created = await api(i % 2 === 0 ? writer.token : app.token, "POST", "comments", {
        parent: { page_id: page.id },
        rich_text: [{ type: "text", text: { content: `turn ${i}` } }],
      });
      expect(created.status).toBe(200);
    }
    await h.app.settled();
    const comments = () => events(mine).filter((event) => event.type === "comment.created").length;

    // my-agent heard Ana, then each integration comment up to the limit (its own too), and nothing after.
    expect(comments()).toBe(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(/^a bot loop in notion [0-9a-f-]{36} was stopped after 50 app messages/),
    ]);
    // The stopped page's writes by integrations are kept, and cause nothing: a rename, blocks, a child page.
    const before = events(mine).length;
    const renamed = await api(writer.token, "PATCH", `pages/${page.id}`, {
      properties: { title: { title: [{ text: { content: "Roadmap, again" } }] } },
    });
    expect(renamed.status).toBe(200);
    const paragraph = { type: "paragraph", paragraph: { rich_text: [{ text: { content: "more" } }] } };
    expect((await api(writer.token, "PATCH", `blocks/${page.id}/children`, { children: [paragraph] })).status).toBe(
      200,
    );
    const child = await api(writer.token, "POST", "pages", {
      parent: { page_id: page.id },
      properties: { title: { title: [{ text: { content: "Child" } }] } },
    });
    expect(child.status).toBe(200);
    await h.app.settled();
    h.timers.advance(1000);
    await h.app.settled();
    expect(events(mine)).toHaveLength(before);

    // A person writing again starts the page over.
    await post(`/users/${ana.id}/comment`, { text: "again", page: page.id });
    await api(writer.token, "POST", "comments", {
      parent: { page_id: page.id },
      rich_text: [{ type: "text", text: { content: "back" } }],
    });
    await h.app.settled();
    expect(comments()).toBe(3 + LOOP_LIMIT);
  });

  test("exit check 12.6: integrations editing a page at each other are stopped at the guard's limit", async () => {
    const { h, sessionId, mine, post, app, writer, ana, api } = await twoIntegrations();
    const page = await post("/pages", { title: "Draft", connections: [app.id, writer.id] });
    await post(`/users/${ana.id}/comment`, { text: "go", page: page.id });
    for (let i = 0; i <= LOOP_LIMIT + 5; i++) {
      await api(i % 2 === 0 ? writer.token : app.token, "PATCH", `pages/${page.id}`, {
        properties: { title: { title: [{ text: { content: `Draft ${i}` } }] } },
      });
    }
    await h.app.settled();
    expect(events(mine).filter((event) => event.type === "page.properties_updated")).toHaveLength(LOOP_LIMIT);
    expect((await h.call("GET", `/sessions/${sessionId}/quiet`)).body.loops).toEqual([
      expect.stringMatching(
        /^a bot loop in notion [0-9a-f-]{36} was stopped after 50 app messages .*\((my-agent → writer → )+my-agent/,
      ),
    ]);
  });

  test("a person and an integration of one session can't share a name", async () => {
    const { post } = await twoIntegrations();
    expect(await refusal(post("/users", { name: "writer" }))).toBe("invalid_argument");
    await post("/users", { name: "editor" });
    expect(await refusal(post("/apps", { name: "editor" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the integration's lines under my-agent's keys", async () => {
    const { h, app, writer } = await twoIntegrations();
    expect((await h.call("GET", "/env?app=writer&channel=notion")).body).toMatchObject({
      NOTION_TOKEN: writer.token,
      NOTION_VERIFICATION_TOKEN: writer.webhookSecret,
    });
    expect((await h.call("GET", "/env?app=my-agent&channel=notion")).body.NOTION_TOKEN).toBe(app.token);
    // An integration no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=summarizer&channel=notion")).body.NOTION_TOKEN).toBe(
      h.secrets.forApp("notion", "summarizer", "token"),
    );
  });
});

describe("R1.12: deliveries by integration", () => {
  test("deliveries({ app }) lists one integration's, beside the type and resource filters", async () => {
    const { h, post, get, app, writer, ana } = await twoIntegrations();
    const shared = await post("/pages", { title: "Shared", connections: [app.id, writer.id] });
    await post(`/users/${ana.id}/comment`, { text: "please draft", page: shared.id });
    await h.app.settled();

    const apps = (query: string) =>
      get(`/deliveries?${query}`).then((list: { app: string; type: string }[]) => list.map((one) => one.app));
    expect(await apps(`app=${writer.id}&type=comment.created`)).toEqual(["writer"]);
    expect(await apps(`app=my-agent&resource=${shared.id}&type=comment.created`)).toEqual(["my-agent"]);
    expect(new Set(await apps(`resource=${shared.id}`))).toEqual(new Set(["my-agent", "writer"]));
  });
});
