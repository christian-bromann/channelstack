import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type NotionStub, notionStub } from "../../../../test/notion-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { NotionRefusal, passing } from "./client.ts";
import { notionMaintenance } from "./maintenance.ts";

/** A server whose Notion driver is live against the stub: the integration's token and the allowlist set, as in CI. */
function liveNotion(stub: NotionStub, allowlist = stub.workspace, extra: Record<string, string> = {}) {
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_NOTION_TOKEN: stub.integration.token,
          CHANNELSTACK_LIVE_NOTION_WORKSPACES: allowlist,
          CHANNELSTACK_RUN_ID: "unit3",
          ...extra,
        },
        fetch: stub.fetch,
        apiBase: { notion: stub.url },
      },
    },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      notion: (method: string, path: string, payload?: unknown) =>
        server.call(method, `/sessions/${body.sessionId}/notion${path}`, payload),
    };
  };
  return { ...server, open };
}

describe("exit check 5.3: Notion's allowlist holds", () => {
  test("a workspace outside CHANNELSTACK_LIVE_NOTION_WORKSPACES is refused before anything is done there", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub, "not-this-workspace").open();
    const person = await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body.error).toBe("live_not_allowlisted");
    expect(person.body.message).toContain("CHANNELSTACK_LIVE_NOTION_WORKSPACES");
    expect(stub.calls.map((call) => call.path)).toEqual(["users/me"]);
  });

  test("a token from another workspace, or the integration's as a person's, is refused", async () => {
    const stub = notionStub();
    const elsewhere = stub.person("Ana", { workspace: "another-workspace" });
    const session = await liveNotion(stub).open();
    expect((await session.notion("POST", "/users", { name: "Ana", token: elsewhere.token })).body.error).toBe(
      "cross_workspace_credential",
    );
    const asIntegration = await session.notion("POST", "/users", { name: "Robin", token: stub.integration.token });
    expect(asIntegration.body.error).toBe("live_misconfigured");
  });

  test("a person's token as the integration's is refused", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub, stub.workspace, { CHANNELSTACK_NOTION_TOKEN: ana.token }).open();
    const person = await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body.error).toBe("live_misconfigured");
    expect(person.body.message).toContain("CHANNELSTACK_NOTION_TOKEN acts as a person");
  });
});

describe("R4.1: one person of the pool in parallel sessions", () => {
  test("the same person in two open sessions acts in both, and stays when one closes", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const server = liveNotion(stub);
    const [one, two] = [await server.open(), await server.open()];
    for (const session of [one, two]) await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const page = await one.notion("POST", "/pages", { title: "Shared", connections: [stub.integration.botId] });
    const first = await one.notion("POST", `/users/${ana.userId}/comment`, { text: "from one", page: page.body.id });
    expect(first.status).toBe(200);
    await server.call("DELETE", `/sessions/${two.id}`);
    const after = await one.notion("POST", `/users/${ana.userId}/comment`, { text: "still here", page: page.body.id });
    expect(after.status).toBe(200);
    expect(after.body.author).toMatchObject({ id: ana.userId, name: "Ana" });
  });
});

describe("live Notion: acting and reading back", () => {
  test("a real person comments on a real page, and the agent's reply is read back", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const server = liveNotion(stub);
    const session = await server.open();

    const fixture = await session.notion("GET", "");
    expect(fixture.body.app).toMatchObject({ id: stub.integration.botId, token: "", webhookSecret: "" });
    expect(fixture.body.apiUrl).toBe("https://api.notion.com");
    expect(JSON.stringify(fixture.body)).not.toContain(stub.integration.token);

    const person = await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    // The test's name for her: Notion's is her email, which never leaves the server.
    expect(person.body).toEqual({ id: ana.userId, name: "Ana", kind: "user", channel: "notion" });

    const page = await session.notion("POST", "/pages", {
      title: "Live smoke test",
      content: "Some **notes**",
      connections: [stub.integration.botId],
    });
    expect(page.status).toBe(200);
    expect(page.body.title).toBe("Live smoke test");
    // In the session's own page, under the page the integration is connected to.
    const home = stub.page(stub.page(page.body.id)?.parent as string);
    expect(home).toMatchObject({ title: "channelstack-run-unit3-1", parent: stub.root });
    expect(stub.calls.find((call) => call.method === "POST" && call.path === "pages")?.as).toBe("Ana");
    expect((await session.notion("GET", `/pages/${page.body.id}/markdown`)).body).toBe("Some **notes**");
    expect((await session.notion("GET", `/pages/${page.body.id}/connections`)).body).toHaveLength(1);

    const comment = await session.notion("POST", `/users/${ana.userId}/comment`, {
      text: "@my-agent summarize this page",
      page: page.body.id,
    });
    expect(comment.status).toBe(200);
    expect(comment.body.author).toEqual({ id: ana.userId, name: "Ana", kind: "user", channel: "notion" });
    // A real mention of the integration, by Ana's token.
    expect(stub.commentsOn(page.body.id)).toEqual([
      expect.objectContaining({ text: "@robin summarize this page", by: ana.userId }),
    ]);
    expect(comment.body.delivery).toBeUndefined();

    // Notion delivers to the agent; here it answers the way it would.
    stub.agentReplies(comment.body.discussion.id, "Here is the summary");
    const thread = await session.notion("GET", `/discussions/${comment.body.discussion.id}/comments`);
    expect(thread.body).toHaveLength(2);
    expect(thread.body[1]).toMatchObject({ text: "Here is the summary", author: { kind: "app", token: "" } });
    const transcript = await session.notion("GET", `/pages/${page.body.id}/transcript`);
    expect(transcript.body.text).toContain("Here is the summary");
    expect(JSON.stringify(transcript.body)).not.toContain("@example.com");
  });

  test("a person edits, renames, mentions, and changes their own comments", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const page = await session.notion("POST", `/users/${ana.userId}/pages`, {
      page: { title: "Notes", content: "first", connections: [stub.integration.botId] },
    });
    expect(page.status).toBe(200);

    await session.notion("POST", `/users/${ana.userId}/edit`, { change: { append: "second" }, page: page.body.id });
    expect((await session.notion("GET", `/pages/${page.body.id}/markdown`)).body).toBe("first\nsecond");
    await session.notion("POST", `/users/${ana.userId}/edit`, { change: { replace: "only" }, page: page.body.id });
    expect((await session.notion("GET", `/pages/${page.body.id}/markdown`)).body).toBe("only");
    await session.notion("POST", `/users/${ana.userId}/rename`, { title: "Renamed", page: page.body.id });
    expect(stub.page(page.body.id)?.title).toBe("Renamed");
    await session.notion("POST", `/users/${ana.userId}/mention`, {
      integration: stub.integration.botId,
      page: page.body.id,
      inBlock: "only",
    });
    expect((await session.notion("GET", `/pages/${page.body.id}/markdown`)).body).toBe("only @robin");

    const anchored = await session.notion("POST", `/users/${ana.userId}/comment`, {
      text: "about this",
      page: page.body.id,
      anchor: "only",
    });
    expect(anchored.body.discussion.anchor).toBe("only @robin");
    await session.notion("POST", `/users/${ana.userId}/edit-comment`, { text: "edited", comment: anchored.body.id });
    const read = await session.notion("GET", `/discussions/${anchored.body.discussion.id}/comments`);
    expect(read.body.map((comment: { text: string }) => comment.text)).toEqual(["edited"]);
    await session.notion("POST", `/users/${ana.userId}/delete-comment`, { comment: anchored.body.id });
    expect((await session.notion("GET", `/discussions/${anchored.body.discussion.id}/comments`)).body).toEqual([]);
  });

  test("no session can name the integration's own page", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const under = await session.notion("POST", "/pages", {
      title: "Straight in",
      parent: stub.root,
      connections: [stub.integration.botId],
    });
    expect(under.body.error).toBe("not_found");
    const comment = await session.notion("POST", `/users/${ana.userId}/comment`, { text: "hi", page: stub.root });
    expect(comment.body.error).toBe("not_found");
    expect(stub.commentsOn(stub.root)).toEqual([]);
  });

  test("a page needs a real person, and one the integration can't see needs a page for that", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    const nobody = await session.notion("POST", "/pages", { title: "Seed", connections: [stub.integration.botId] });
    expect(nobody.body).toMatchObject({ error: "action_requires", data: { requires: "a real person" } });
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const unseen = await session.notion("POST", "/pages", { title: "Private" });
    expect(unseen.body.error).toBe("live_misconfigured");
    expect(unseen.body.message).toContain("CHANNELSTACK_NOTION_UNSEEN_PAGE");
  });

  test("databases, connections and delivery chaos are refused live, before anything reaches Notion", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const before = stub.calls.length;
    const database = await session.notion("POST", "/databases", { title: "Tasks", properties: { Name: "title" } });
    expect(database.body.error).toBe("unsupported_in_live");
    expect(
      (await session.notion("POST", `/users/${ana.userId}/connect`, { integration: stub.integration.botId, page: "p" }))
        .body,
    ).toMatchObject({ error: "action_requires", data: { requires: "the browser actor" } });
    expect((await session.notion("POST", "/deliveries/x/redeliver")).body.error).toBe("unsupported_in_live");
    expect(stub.calls.length).toBe(before);
  });

  test("a fake person can't act in a live workspace", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const ben = await session.notion("POST", "/users", { name: "Ben" });
    expect(ben.status).toBe(200);
    const page = await session.notion("POST", "/pages", { title: "Seed", connections: [stub.integration.botId] });
    const comment = await session.notion("POST", `/users/${ben.body.id}/comment`, { text: "hi", page: page.body.id });
    expect(comment.body.error).toBe("fake_actor_in_live_world");
  });
});

describe("exit check 5.2: Notion cleanup", () => {
  test("closing the session moves its page to the trash, and everything in it", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const server = liveNotion(stub);
    const session = await server.open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const page = await session.notion("POST", "/pages", { title: "Seed", connections: [stub.integration.botId] });
    const home = stub.page(page.body.id)?.parent as string;
    await server.call("DELETE", `/sessions/${session.id}`);
    expect(stub.page(home)?.inTrash).toBe(true);
    expect(stub.calls.at(-1)).toEqual({ method: "PATCH", path: `pages/${home}`, as: "Ana" });
  });
});

describe("R4.5: Notion's own failure on the first check passes", () => {
  test("a rate limit or Notion's own failure is asked again later; a refusal of the credential isn't", () => {
    // Notion's client retries these three times itself; what still fails reaches the first check.
    for (const code of ["rate_limited", "service_unavailable", "internal_server_error", "gateway_timeout"]) {
      expect(passing(new NotionRefusal(code, "busy")), code).toBe(true);
    }
    for (const code of ["unauthorized", "restricted_resource", "object_not_found", "validation_error"]) {
      expect(passing(new NotionRefusal(code, "no")), code).toBe(false);
    }
  });
});

describe("exit check 5.2: Notion's doctor and sweep", () => {
  const env = (stub: NotionStub, person: { token: string }, extra: Record<string, string> = {}) => ({
    CHANNELSTACK_NOTION_TOKEN: stub.integration.token,
    CHANNELSTACK_NOTION_USER_ANA_TOKEN: person.token,
    CHANNELSTACK_LIVE_NOTION_WORKSPACES: stub.workspace,
    ...extra,
  });
  const input = (stub: NotionStub, environment: Record<string, string>) => ({
    env: environment,
    fetch: stub.fetch,
    timers: systemTimers,
    apiBase: stub.url,
  });

  test("doctor: the integration and a person in the workspace, and what isn't", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const ok = await notionMaintenance.doctor(input(stub, env(stub, ana)));
    expect(ok.map((check) => check.ok)).toEqual([true, true]);
    expect(ok[0]?.text).toContain(`the integration in workspace ${stub.workspace}`);
    const elsewhere = await notionMaintenance.doctor(
      input(stub, env(stub, ana, { CHANNELSTACK_LIVE_NOTION_WORKSPACES: "nope" })),
    );
    expect(elsewhere.every((check) => !check.ok)).toBe(true);
    const swapped = await notionMaintenance.doctor(
      input(stub, env(stub, ana, { CHANNELSTACK_NOTION_TOKEN: ana.token })),
    );
    expect(swapped[0]?.text).toContain("acts as a person");
  });

  test("sweep: a ledgered page once, a tagged page of the run, and the age cutoff", async () => {
    const stub = notionStub();
    const ana = stub.person("Ana");
    const session = await liveNotion(stub).open();
    await session.notion("POST", "/users", { name: "Ana", token: ana.token });
    const page = await session.notion("POST", "/pages", { title: "Seed", connections: [stub.integration.botId] });
    const home = stub.page(page.body.id)?.parent as string;
    const entry: LedgerEntry = {
      id: "unit3-1-1",
      channel: "notion",
      kind: "page",
      ref: { page: home, name: "channelstack-run-unit3-1" },
      workspace: stub.workspace,
      by: "user:ANA",
      run: "unit3",
      session: session.id,
      createdAt: 0,
    };
    const sweep = (options: { check: boolean; entries: LedgerEntry[]; run?: string; olderThanMs?: number }) =>
      notionMaintenance.sweep({
        ...input(stub, env(stub, ana)),
        entries: options.entries,
        check: options.check,
        run: options.run,
        olderThanMs: options.olderThanMs ?? 0,
        now: Date.now(),
      });
    // Listed once: the ledger names it, so the scan for tagged pages doesn't list it again.
    expect((await sweep({ check: true, entries: [entry], run: "unit3" })).left).toEqual([
      "page channelstack-run-unit3-1 (run unit3)",
    ]);
    // Without a ledger: found by its tag, for this run, and not before it is old enough for every run.
    expect((await sweep({ check: true, entries: [], run: "unit3" })).left).toEqual(["page channelstack-run-unit3-1"]);
    expect((await sweep({ check: true, entries: [], olderThanMs: 3_600_000 })).left).toEqual([]);
    const swept = await sweep({ check: false, entries: [entry], run: "unit3" });
    expect(swept.done).toEqual([entry]);
    expect(stub.page(home)?.inTrash).toBe(true);
  });
});
