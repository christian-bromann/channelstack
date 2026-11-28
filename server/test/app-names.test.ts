/**
 * Exit check 12.12 on every channel: a name in a session means one of that session's people or
 * one of the apps that session used (`my-agent`, and each it got from `createApp`), never an app
 * only another session made (decision 0027). So parallel tests can't change each other's names.
 */
import { describe, expect, test } from "vitest";

import { harness, refusal } from "./app-harness.ts";

/** Two sessions of one server: `mine` made the app `reviewer`, `theirs` didn't. */
async function twoSessions(channel: string) {
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
  const reviewer = await mine.post("/apps", { name: "reviewer" });
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
