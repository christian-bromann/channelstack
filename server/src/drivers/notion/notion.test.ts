import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { harness, recordingAgent, refusal } from "../../../test/app-harness.ts";
import { blockToMarkdown, markdownToBlocks } from "./markdown.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const VERSION: Record<string, string> = { "notion-version": "2025-09-03" };

/** A Notion workspace for a test: the app in memory, a stand-in agent, one session with Ana in it. */
async function workspace({ reachable = true }: { reachable?: boolean } = {}) {
  const agent = await recordingAgent();
  closers.push(() => agent.close());
  const h = harness(reachable ? { notion: agent.url } : {});
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/notion`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await h.call(method, `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(String(response.body?.error)), response);
    return response.body;
  };
  const post = (path: string, body?: unknown) => call("POST", path, body);
  const get = (path: string) => call("GET", path);
  const { app } = await get("");
  const ana = await post("/users", { name: "Ana" });
  /** The REST API as the integration calls it. */
  const api = (method: string, path: string, body?: unknown, token: string | null = app.token, headers = VERSION) =>
    h.provider(method, `notion/v1/${path}`, body, token, headers);
  const events = () => agent.received.map(({ headers, body }) => ({ headers, body, event: JSON.parse(body) }));
  return { h, agent, app, ana, post, get, api, events };
}

describe("the REST API", () => {
  test("the integration's token and a Notion-Version, as Notion asks for them", async () => {
    const { api } = await workspace();
    expect((await api("GET", "users/me", undefined, null)).body).toMatchObject({
      object: "error",
      status: 401,
      code: "unauthorized",
    });
    expect((await api("GET", "users/me", undefined, "ntn_someoneelse")).status).toBe(401);
    expect((await api("GET", "users/me", undefined, undefined, {})).body.code).toBe("missing_version");
    const me = await api("GET", "users/me");
    expect(me.body).toMatchObject({ object: "user", type: "bot", name: "my-agent", bot: { workspace_name: "Acme" } });
    expect((await api("GET", "nothing/here")).body.code).toBe("invalid_request_url");
  });

  test("only what the integration is connected to, itself or through a parent", async () => {
    const { post, api } = await workspace();
    const hidden = await post("/pages", { title: "Private notes", content: "secret" });
    expect((await api("GET", `pages/${hidden.id}`)).body).toMatchObject({ status: 404, code: "object_not_found" });
    expect((await api("GET", `blocks/${hidden.id}/children`)).status).toBe(404);
    const space = await post("/pages", { title: "Engineering", connections: [(await api("GET", "users/me")).body.id] });
    const child = await post("/pages", { title: "On-call", parent: space.id, content: "# Rota\n- Ana" });
    const page = await api("GET", `pages/${child.id}`);
    expect(page.body).toMatchObject({
      object: "page",
      parent: { type: "page_id", page_id: space.id },
      properties: { title: { type: "title", title: [{ plain_text: "On-call" }] } },
    });
    // The child page is a block of its parent, with the page's own id.
    const above = await api("GET", `blocks/${space.id}/children`);
    expect(above.body.results).toMatchObject([{ id: child.id, type: "child_page", child_page: { title: "On-call" } }]);
    const blocks = await api("GET", `blocks/${child.id}/children`);
    expect(blocks.body).toMatchObject({ object: "list", type: "block", has_more: false });
    expect(blocks.body.results.map((block: { type: string }) => block.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
    ]);
    // Paging: a cursor of the list goes on from there; one that names nothing, or a size out of range, is refused.
    const second = await api("GET", `blocks/${child.id}/children?page_size=1`);
    expect(second.body).toMatchObject({ has_more: true });
    const rest = await api("GET", `blocks/${child.id}/children?start_cursor=${second.body.next_cursor}`);
    expect(rest.body.results.map((block: { type: string }) => block.type)).toEqual(["bulleted_list_item"]);
    expect((await api("GET", `blocks/${child.id}/children?start_cursor=${hidden.id}`)).body.code).toBe(
      "validation_error",
    );
    expect((await api("GET", `blocks/${child.id}/children?page_size=lots`)).body.code).toBe("validation_error");
    expect((await api("GET", `blocks/${child.id}/children?page_size=101`)).body.code).toBe("validation_error");
    const search = await api("POST", "search", { query: "" });
    expect(search.body.results.map((result: { id: string }) => result.id).sort()).toEqual([space.id, child.id].sort());
  });

  test("the integration writes blocks and comments; a resolved discussion no longer lists", async () => {
    const { ana, app, post, get, api } = await workspace();
    const page = await post("/pages", { title: "Notes", content: "- one", connections: [app.id] });
    const appended = await api("PATCH", `blocks/${page.id}/children`, {
      children: [{ type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: "ship it" } }] } }],
    });
    expect(appended.body.results).toMatchObject([
      { type: "to_do", to_do: { checked: false, rich_text: [{ plain_text: "ship it" }] } },
    ]);
    expect(await get(`/pages/${page.id}/markdown`)).toBe("- one\n- [ ] ship it");
    const comment = await post(`/users/${ana.id}/comment`, { text: "@my-agent hi", page: page.id });
    expect(comment.text).toBe("@my-agent hi");
    // Anchored by a pattern, as the SDKs send a RegExp.
    const anchored = await post(`/users/${ana.id}/comment`, {
      text: "this one",
      page: page.id,
      anchor: { source: "^-?\\s*ONE$", flags: "i" },
    });
    expect(anchored.discussion.anchor).toBe("one");
    const global = await post(`/users/${ana.id}/comment`, {
      text: "again",
      page: page.id,
      anchor: { source: "one", flags: "gy" },
    });
    expect(global.discussion.anchor).toBe("one");
    expect(
      await refusal(post(`/users/${ana.id}/comment`, { text: "x", page: page.id, anchor: { source: "(", flags: "" } })),
    ).toBe("invalid_argument");
    const created = await api("POST", "comments", {
      discussion_id: comment.discussion.id,
      rich_text: [{ type: "text", text: { content: "Hello Ana" } }],
    });
    expect(created.body).toMatchObject({
      object: "comment",
      discussion_id: comment.discussion.id,
      display_name: { type: "integration", resolved_name: "my-agent" },
    });
    const listed = await api("GET", `comments?block_id=${page.id}`);
    expect(
      listed.body.results.map((entry: { rich_text: Array<{ plain_text: string }> }) =>
        entry.rich_text.map((item) => item.plain_text).join(""),
      ),
    ).toEqual(["@my-agent hi", "Hello Ana"]);
    // A mention of the bot carries its user as Notion fills it in; a person's is their id.
    const me = (await api("GET", "users/me")).body;
    const botUser = { object: "user", id: me.id, name: "my-agent", avatar_url: null, type: "bot", bot: {} };
    expect(listed.body.results[0].rich_text[0]).toMatchObject({ type: "mention", plain_text: "@my-agent" });
    expect(listed.body.results[0].rich_text[0].mention).toEqual({ type: "user", user: botUser });
    const mentions = await api("POST", "comments", {
      discussion_id: comment.discussion.id,
      rich_text: [
        { type: "mention", mention: { user: { id: me.id } } },
        { type: "mention", mention: { user: { id: ana.id } } },
      ],
    });
    expect(mentions.body.rich_text.map((item: { mention: { user: unknown } }) => item.mention.user)).toEqual([
      botUser,
      { object: "user", id: ana.id },
    ]);
    await post(`/users/${ana.id}/resolve`, { discussion: comment.discussion.id });
    expect((await api("GET", `comments?block_id=${page.id}`)).body.results).toEqual([]);
    expect(await get(`/discussions/${comment.discussion.id}/resolved`)).toBe(true);
    expect((await api("POST", "comments", { rich_text: [] })).body.code).toBe("validation_error");
    // A refused create or append leaves nothing behind: no page, no child page block, no blocks.
    const before = (await api("GET", `blocks/${page.id}/children`)).body.results.length;
    const refused = await api("POST", "pages", {
      parent: { page_id: page.id },
      properties: { title: { title: [{ text: { content: "Half made" } }] }, Nope: { number: 1 } },
    });
    expect(refused.body.code).toBe("validation_error");
    const badChild = await api("POST", "pages", { parent: { page_id: page.id }, children: [{ nonsense: true }] });
    expect(badChild.body.code).toBe("validation_error");
    const badAfter = await api("PATCH", `blocks/${page.id}/children`, {
      children: [{ type: "paragraph", paragraph: { rich_text: [{ text: { content: "x" } }] } }],
      after: "00000000-0000-4000-8000-000000000000",
    });
    expect(badAfter.body.code).toBe("validation_error");
    expect((await api("GET", `blocks/${page.id}/children`)).body.results).toHaveLength(before);
    expect((await api("POST", "search", { query: "Half made" })).body.results).toEqual([]);
  });

  test("databases: a data source to query, rows to update, Notion's refusals", async () => {
    const { ana, app, post, get, api } = await workspace();
    const tasks = await post("/databases", {
      title: "Tasks",
      properties: { Name: "title", Status: { status: ["Todo", "Done"] }, Estimate: "number" },
      rows: [
        { Name: "Write docs", Status: "Todo" },
        { Name: "Ship", Status: "Done" },
      ],
      connections: [app.id],
    });
    const database = await api("GET", `databases/${tasks.id}`);
    const [source] = database.body.data_sources;
    const todo = await api("POST", `data_sources/${source.id}/query`, {
      filter: { property: "Status", status: { equals: "Todo" } },
    });
    expect(todo.body.results).toHaveLength(1);
    const [row] = todo.body.results;
    expect(row.properties).toMatchObject({
      Name: { type: "title" },
      Status: { status: { name: "Todo" } },
      Estimate: { number: null },
    });
    await api("PATCH", `pages/${row.id}`, { properties: { Estimate: { number: 5 } } });
    expect(await get(`/pages/${row.id}/property?name=Estimate`)).toBe(5);
    expect(
      (await api("PATCH", `pages/${row.id}`, { properties: { Status: { status: { name: "Nope" } } } })).body.code,
    ).toBe("validation_error");
    expect((await api("PATCH", `pages/${row.id}`, { properties: { Missing: { number: 1 } } })).body.code).toBe(
      "validation_error",
    );
    // A value of the wrong type is Notion's 400, not a server error.
    for (const properties of [{ Estimate: { number: "five" } }, { Estimate: { checkbox: true } }]) {
      const refused = await api("PATCH", `pages/${row.id}`, { properties });
      expect([refused.status, refused.body.code]).toEqual([400, "validation_error"]);
    }
    const [first] = await post(`/databases/${tasks.id}/rows`, { filter: { Name: "Write docs" } });
    expect(first.id).toBe(row.id);
    expect(
      await refusal(post(`/users/${ana.id}/set-property`, { name: "Estimate", value: "lots", page: row.id })),
    ).toBe("invalid_argument");
  });
  test("a data source query compares by type: numbers as numbers, text without case, lists by what they hold", async () => {
    const { app, post, api } = await workspace();
    const tasks = await post("/databases", {
      title: "Estimates",
      properties: { Name: "title", Estimate: "number", Tags: { multi_select: ["api", "ui"] } },
      rows: [
        { Name: "Ten", Estimate: 10, Tags: ["api"] },
        { Name: "Nine", Estimate: 9, Tags: ["ui"] },
        { Name: "None", Tags: [] },
      ],
      connections: [app.id],
    });
    const [source] = (await api("GET", `databases/${tasks.id}`)).body.data_sources;
    const names = async (body: object) => {
      const answer = await api("POST", `data_sources/${source.id}/query`, body);
      if (answer.status !== 200) return answer.body.code;
      return answer.body.results.map((row: { properties: { Name: { title: Array<{ plain_text: string }> } } }) =>
        row.properties.Name.title.map((item) => item.plain_text).join(""),
      );
    };
    expect(await names({ sorts: [{ property: "Estimate", direction: "ascending" }] })).toEqual(["Nine", "Ten", "None"]);
    expect(await names({ filter: { property: "Tags", multi_select: { does_not_contain: "api" } } })).toEqual([
      "Nine",
      "None",
    ]);
    expect(await names({ filter: { property: "Name", title: { does_not_contain: "TEN" } } })).toEqual(["Nine", "None"]);
    expect(await names({ filter: { property: "Estimate", number: { greater_than: 9 } } })).toEqual(["Ten"]);
    expect(await names({ filter: { property: "Estimate", number: { is_empty: true } } })).toEqual(["None"]);
    expect(await names({ filter: { property: "Estimate", number: { sounds_like: 9 } } })).toBe("validation_error");
    // A new multi-select name becomes an option, but only with a change Notion takes.
    const tagsOf = async () =>
      (await api("GET", `data_sources/${source.id}`)).body.properties.Tags.multi_select.options.map(
        (option: { name: string }) => option.name,
      );
    const [ten] = (
      await api("POST", `data_sources/${source.id}/query`, { filter: { property: "Name", title: { equals: "Ten" } } })
    ).body.results;
    const refused = await api("PATCH", `pages/${ten.id}`, {
      properties: { Tags: { multi_select: [{ name: "new" }] }, Nope: { number: 1 } },
    });
    expect(refused.status).toBe(400);
    expect(await tagsOf()).toEqual(["api", "ui"]);
    await api("PATCH", `pages/${ten.id}`, { properties: { Tags: { multi_select: [{ name: "new" }] } } });
    expect(await tagsOf()).toEqual(["api", "ui", "new"]);
  });
});

describe("webhooks", () => {
  test("signed with the verification token over the exact body, each attempt numbered", async () => {
    const { h, agent, ana, app, post } = await workspace();
    const page = await post("/pages", { title: "Roadmap", connections: [app.id] });
    const comment = await post(`/users/${ana.id}/comment`, { text: "@my-agent summarize", page: page.id });
    await h.app.settled();
    const [first] = agent.received;
    const sign = (body: string) => `sha256=${createHmac("sha256", app.webhookSecret).update(body).digest("hex")}`;
    expect(first?.headers["x-notion-signature"]).toBe(sign(first?.body ?? ""));
    expect(JSON.parse(first?.body ?? "{}")).toMatchObject({
      type: "comment.created",
      entity: { id: comment.id, type: "comment" },
      data: { page_id: page.id, discussion_id: comment.discussion.id, parent: { id: page.id, type: "page" } },
      authors: [{ id: ana.id, type: "person" }],
      attempt_number: 1,
      api_version: "2025-09-03",
    });
    await post(`/deliveries/${comment.delivery.id}/redeliver`);
    await h.app.settled();
    const again = agent.received.at(-1);
    expect(JSON.parse(again?.body ?? "{}").attempt_number).toBe(2);
    expect(again?.headers["x-notion-signature"]).toBe(sign(again?.body ?? ""));
    await post(`/deliveries/${comment.delivery.id}/resend`, { badSignature: true });
    await h.app.settled();
    const forged = agent.received.at(-1);
    expect(forged?.headers["x-notion-signature"]).not.toBe(sign(forged?.body ?? ""));
  });

  test("a page the integration can't see sends nothing", async () => {
    const { h, agent, ana, post } = await workspace();
    const page = await post("/pages", { title: "Private" });
    const comment = await post(`/users/${ana.id}/comment`, { text: "@my-agent read this", page: page.id });
    await h.app.settled();
    expect(comment.delivery).toBeUndefined();
    expect(agent.received).toEqual([]);
  });

  test("content updates are batched: one event for every block changed during the delay", async () => {
    const { h, agent, ana, app, post, get, api } = await workspace();
    const page = await post("/pages", { title: "Draft", content: "## Intro\nTODO", connections: [app.id] });
    await post("/content-delay", { delay: 2000 });
    await post(`/users/${ana.id}/edit`, { change: { append: "first" }, page: page.id });
    await post(`/users/${ana.id}/mention`, { integration: app.id, page: page.id, inBlock: "TODO" });
    await h.app.settled();
    expect(agent.received).toEqual([]);
    h.timers.advance(2000);
    await h.app.settled();
    expect(agent.received).toHaveLength(1);
    const event = JSON.parse(agent.received[0]?.body ?? "{}");
    expect(event).toMatchObject({ type: "page.content_updated", entity: { id: page.id, type: "page" } });
    expect(event.data.updated_blocks).toHaveLength(2);
    expect(await get(`/pages/${page.id}/markdown`)).toBe("## Intro\nTODO @my-agent\nfirst");
    // The mention in the body carries the bot's user, as Notion fills it in.
    const me = (await api("GET", "users/me")).body;
    const todo = (await api("GET", `blocks/${page.id}/children`)).body.results[1];
    expect(todo.paragraph.rich_text.at(-1).mention).toEqual({
      type: "user",
      user: { object: "user", id: me.id, name: "my-agent", avatar_url: null, type: "bot", bot: {} },
    });
  });

  test("the verification request carries the token, and isn't signed", async () => {
    const { h, agent, app, post } = await workspace();
    const sent = await post("/verification");
    await h.app.settled();
    expect(sent).toMatchObject({ type: "verification", payload: { verification_token: "[redacted]" } });
    expect(JSON.parse(agent.received[0]?.body ?? "{}")).toEqual({ verification_token: app.webhookSecret });
    expect(agent.received[0]?.headers["x-notion-signature"]).toBeUndefined();
  });
});

describe("Markdown", () => {
  test("Markdown becomes Notion's blocks, and reads back the same", () => {
    const source =
      "# Title\n## Part\nSome **bold** and `code`\n- one\n  - nested\n1. first\n- [ ] todo\n- [x] done\n> quoted\n---";
    const blocks = markdownToBlocks(source);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "to_do",
      "quote",
      "divider",
    ]);
    const render = (drafts: typeof blocks): string[] =>
      drafts.map((block) => blockToMarkdown(block.type, block.data, render(block.children)));
    expect(render(blocks).join("\n")).toBe(source);
  });
});
