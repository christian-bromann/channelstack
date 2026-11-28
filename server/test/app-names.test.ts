/**
 * Exit check 12.12 on every channel: a name in a session means one of that session's people or
 * one of the apps that session used (`my-agent`, and each it got from `createApp`), never an app
 * only another session made (decision 0027). So parallel tests can't change each other's names.
 */
import { describe, expect, test } from "vitest";

import { harness, refusal } from "./app-harness.ts";

/** Two sessions of one server: `mine` made the app (`reviewer` unless named), `theirs` didn't. */
async function twoSessions(channel: string, app = "reviewer") {
  const h = harness();
  const session = async () => {
    const { sessionId } = (await h.call("POST", "/sessions")).body;
    const base = `/sessions/${sessionId}/${channel}`;
    const post = async (path: string, body?: unknown) => {
      const response = await h.call("POST", `${base}${path}`, body);
      if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
      return response.body;
    };
    const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
    return { post, get };
  };
  const mine = await session();
  const theirs = await session();
  const reviewer = await mine.post("/apps", { name: app });
  return { h, mine, theirs, reviewer };
}

/** How each channel's fixture makes a person called Reviewer. */
const REVIEWER: Record<string, Record<string, unknown>> = {
  slack: { name: "Reviewer" },
  discord: { name: "Reviewer" },
  github: { login: "reviewer" },
  linear: { name: "Reviewer" },
  notion: { name: "Reviewer" },
  resend: { name: "Reviewer" },
  google: { name: "Reviewer" },
  echo: { name: "Reviewer" },
};

describe("exit check 12.12: another session's apps never change what a name means", () => {
  test.each(Object.keys(REVIEWER))(
    "%s: a person may have the name of an app only another session used, and not of one their own did",
    async (channel) => {
      const { mine, theirs } = await twoSessions(channel);
      const person = REVIEWER[channel];
      await theirs.post("/users", person);
      expect(await refusal(mine.post("/users", person))).toBe("invalid_argument");
      // Asking for the app makes it one of the session's, which a person of it already has the name of.
      expect(await refusal(theirs.post("/apps", { name: "reviewer" }))).toBe("invalid_argument");
    },
  );

  test("slack: @reviewer is the app where the session made it, and the person where it didn't", async () => {
    const { mine, theirs, reviewer } = await twoSessions("slack");
    const said = async (side: typeof mine, other: { id: string }) => {
      const ana = await side.post("/users", { name: "Ana" });
      const { app } = await side.get("");
      const channel = await side.post("/channels", { participants: [ana.id, app.id, other.id] });
      return (await side.post(`/users/${ana.id}/say`, { message: { text: "@reviewer hi" }, channel: channel.id })).text;
    };
    expect(await said(mine, reviewer)).toBe(`<@${reviewer.botUserId}> hi`);
    const person = await theirs.post("/users", REVIEWER.slack);
    expect(await said(theirs, person)).toBe(`<@${person.id}> hi`);
  });

  test("discord: @reviewer is the app where the session made it, and the person where it didn't", async () => {
    const { mine, theirs, reviewer } = await twoSessions("discord");
    const said = async (side: typeof mine, other: { id: string }) => {
      const ana = await side.post("/users", { name: "Ana" });
      const { app } = await side.get("");
      const channel = await side.post("/channels", { participants: [ana.id, app.id, other.id] });
      return (await side.post(`/users/${ana.id}/say`, { text: { content: "@reviewer hi" }, channel: channel.id }))
        .content;
    };
    expect(await said(mine, reviewer)).toBe(`<@${reviewer.botUserId}> hi`);
    const person = await theirs.post("/users", REVIEWER.discord);
    expect(await said(theirs, person)).toBe(`<@${person.id}> hi`);
  });

  test("linear: @reviewer opens a session for the app where the session made it, and none where it didn't", async () => {
    const { mine, theirs, reviewer } = await twoSessions("linear");
    const commented = async (side: typeof mine) => {
      const ana = await side.post("/users", { name: "Ana" });
      const team = await side.post("/teams", { members: [ana.id] });
      const issue = await side.post(`/users/${ana.id}/issues`, { issue: { title: "Checkout fails" }, team: team.id });
      return side.post(`/users/${ana.id}/comment`, { body: "@reviewer can you look?", issue: issue.id });
    };
    expect((await commented(mine)).session?.app.id).toBe(reviewer.id);
    await theirs.post("/users", REVIEWER.linear);
    expect((await commented(theirs)).session).toBeUndefined();
  });

  test("notion: @reviewer mentions the integration where the session made it, and the person where it didn't", async () => {
    const { h, mine, theirs, reviewer } = await twoSessions("notion");
    const mentioned = async (side: typeof mine) => {
      const ana = await side.post("/users", { name: "Ana" });
      const { app } = await side.get("");
      const page = await side.post("/pages", { title: "Plan", connections: [app.id] });
      await side.post(`/users/${ana.id}/comment`, { text: "@reviewer please look", page: page.id });
      const read = await h.provider("GET", `notion/v1/comments?block_id=${page.id}`, undefined, app.token, {
        "notion-version": "2025-09-03",
      });
      return read.body.results[0].rich_text[0].mention.user.id;
    };
    expect(await mentioned(mine)).toBe(reviewer.id);
    const person = await theirs.post("/users", REVIEWER.notion);
    expect(await mentioned(theirs)).toBe(person.id);
  });
});

type Side = Awaited<ReturnType<typeof twoSessions>>["theirs"];

/** A name or a login no other try has used: some channels keep a person's name unique in a session. */
let made = 0;
const fresh = (prefix: string) => `${prefix}${++made}`;

/**
 * Each place a test gives an app's handle beside people's (a participant, a member, an installed
 * App, a delegate, a connection, a recipient), per channel. Each try makes what it needs itself.
 */
const HANDED: Record<string, Array<[what: string, hand: (side: Side, app: string) => Promise<unknown>]>> = {
  slack: [
    [
      "a channel's participant",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post("/channels", { participants: [ana.id, app] });
      },
    ],
    [
      "invited to a channel",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        const channel = await side.post("/channels", { participants: [ana.id] });
        return side.post(`/users/${ana.id}/invite`, { participants: [app], channel: channel.id });
      },
    ],
    [
      "a DM's other end",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post(`/users/${ana.id}/open-dm`, { participants: [app] });
      },
    ],
  ],
  discord: [
    [
      "a channel's participant",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post("/channels", { participants: [ana.id, app] });
      },
    ],
    [
      "invited to a channel",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana"), admin: true });
        const channel = await side.post("/channels", { participants: [ana.id] });
        return side.post(`/users/${ana.id}/invite`, { participants: [app], channel: channel.id });
      },
    ],
    [
      "a DM's other end",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post(`/users/${ana.id}/open-dm`, { participant: app });
      },
    ],
  ],
  github: [
    ["installed on a new repository", (side, app) => side.post("/repos", { apps: [app] })],
    [
      "installed on a repository",
      async (side, app) => {
        const repo = await side.post("/repos", {});
        return side.post(`/repos/${repo.id}/install`, { app });
      },
    ],
    [
      "an assignee",
      async (side, app) => {
        const ana = await side.post("/users", { login: fresh("ana") });
        const repo = await side.post("/repos", { collaborators: [{ user: ana.id }], apps: [app] });
        const issue = await side.post(`/users/${ana.id}/issues`, { issue: { title: "Login fails" }, repo: repo.id });
        return side.post(`/users/${ana.id}/assign`, {
          assignees: [app],
          issue: { repoId: repo.id, number: issue.number },
        });
      },
    ],
  ],
  linear: [
    [
      "a new issue's delegate",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        const team = await side.post("/teams", { members: [ana.id] });
        return side.post(`/users/${ana.id}/issues`, {
          issue: { title: "Checkout fails", delegate: app },
          team: team.id,
        });
      },
    ],
    [
      "delegated an issue",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        const team = await side.post("/teams", { members: [ana.id] });
        const issue = await side.post(`/users/${ana.id}/issues`, { issue: { title: "Checkout fails" }, team: team.id });
        return side.post(`/users/${ana.id}/delegate`, { app, issue: issue.id });
      },
    ],
  ],
  notion: [
    ["a new page's connection", (side, app) => side.post("/pages", { title: "Plan", connections: [app] })],
    [
      "connected to a page",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        const page = await side.post("/pages", { title: "Plan" });
        return side.post(`/users/${ana.id}/connect`, { integration: app, page: page.id });
      },
    ],
    [
      "mentioned in a page",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        const page = await side.post("/pages", { title: "Plan" });
        return side.post(`/users/${ana.id}/mention`, { integration: app, page: page.id });
      },
    ],
  ],
  resend: [
    [
      "a recipient",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post(`/users/${ana.id}/send`, { to: [app], subject: "Hi", text: "Hi" });
      },
    ],
  ],
  google: [
    [
      "a recipient",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post(`/users/${ana.id}/send`, { to: [app], subject: "Hi", text: "Hi" });
      },
    ],
  ],
  echo: [
    [
      "a room's participant",
      async (side, app) => {
        const ana = await side.post("/users", { name: fresh("Ana") });
        return side.post("/rooms", { participants: [ana.id, app] });
      },
    ],
  ],
};

describe("R2.2: a session sees and takes only the apps it used", () => {
  test.each(Object.keys(HANDED))(
    "%s: another session's app isn't in apps(), and its handle is not_found until the session makes it too",
    async (channel) => {
      const { mine, theirs, reviewer: coder } = await twoSessions(channel, "coder");
      const ids = async (side: Side) => ((await side.get("/apps")) as Array<{ id: string }>).map(({ id }) => id);

      // The session that made coder lists it and hands it everywhere.
      expect(await ids(mine)).toContain(coder.id);
      for (const [what, hand] of HANDED[channel] ?? []) {
        expect(await refusal(hand(mine, coder.id)), what).toBe("no error");
      }

      // Another session sees only its built-in app, and coder's handle is nobody there.
      const builtIn = (await theirs.get("")).app.id;
      expect(await ids(theirs)).toEqual([builtIn]);
      for (const [what, hand] of HANDED[channel] ?? []) {
        expect(await refusal(hand(theirs, coder.id)), what).toBe("not_found");
      }

      // Once it asks for coder itself, it gets the same app, which belongs to the world, and may hand it.
      expect((await theirs.post("/apps", { name: "coder" })).id).toBe(coder.id);
      expect(await ids(theirs)).toEqual([builtIn, coder.id]);
      for (const [what, hand] of HANDED[channel] ?? []) {
        expect(await refusal(hand(theirs, coder.id)), what).toBe("no error");
      }
    },
  );
});

describe("R3.2: where an app's handle goes, its name is no handle", () => {
  test.each(Object.keys(HANDED))("%s: handing over an app by its name is not_found", async (channel) => {
    const { mine } = await twoSessions(channel, "coder");
    for (const [what, hand] of HANDED[channel] ?? []) {
      expect(await refusal(hand(mine, "coder")), what).toBe("not_found");
    }
  });
});

describe("R3.1: the agent's own calls know the whole workspace", () => {
  test("slack: an app DMs a person of a session that never used it, by conversations.open and by a post to their id", async () => {
    const { h, theirs, reviewer: coder } = await twoSessions("slack", "coder");
    const bea = await theirs.post("/users", { name: "Bea" });
    const web = async (method: string, args: Record<string, unknown>) =>
      h.provider("POST", `slack/api/${method}`, args, coder.botToken);

    const opened = await web("conversations.open", { users: bea.id });
    expect(opened).toMatchObject({ status: 200, body: { ok: true } });
    const posted = await web("chat.postMessage", { channel: bea.id, text: "your review is ready" });
    expect(posted).toMatchObject({ status: 200, body: { ok: true, channel: opened.body.channel.id } });
  });
});
