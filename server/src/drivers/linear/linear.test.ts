import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { refusal } from "../../../test/app-harness.ts";
import { linearWorkspace } from "../../../test/linear-workspace.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function workspace(options?: Parameters<typeof linearWorkspace>[0]) {
  const space = await linearWorkspace(options);
  closers.push(() => {
    space.agent.close();
    // Whatever a test is about, every answer and every webhook in it is what Linear's schema describes.
    expect(space.problems.join("\n")).toBe("");
    expect(space.webhookIssues().join("\n")).toBe("");
  });
  const issue = (title = "Checkout fails on Safari", extra: object = {}) =>
    space.post(`/users/${space.ana.id}/issues`, { issue: { title, ...extra }, team: space.team.id });
  return { ...space, issue };
}

const ACTIVITY = `mutation Publish($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success lastSyncId agentActivity { id content { __typename ... on AgentActivityThoughtContent { body } } } }
}`;

describe("agent sessions", () => {
  test("delegating opens a session; the agent's activities move it along as Linear documents", async () => {
    const { h, ana, app, post, get, gql, webhooks, issue } = await workspace();
    const created = await issue();
    expect(created).toMatchObject({
      identifier: "ENG-1",
      url: expect.stringMatching(/\/acme\/issue\/ENG-1\/checkout-fails-on-safari$/),
    });
    const session = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: created.id });
    await h.app.settled();
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("pending");

    const event = webhooks().find((hook) => hook.event === "AgentSessionEvent");
    expect(event?.payload).toMatchObject({
      type: "AgentSessionEvent",
      action: "created",
      agentSession: {
        id: session.id,
        status: "pending",
        issue: { identifier: "ENG-1", team: { key: "ENG" } },
        creator: { name: "Ana" },
      },
      appUserId: app.id,
      promptContext: expect.stringContaining('<issue identifier="ENG-1">'),
    });
    expect(session.delivery).toMatchObject({ type: "AgentSessionEvent", action: "created" });

    const publish = (content: object, extra: object = {}) =>
      gql(ACTIVITY, { input: { agentSessionId: session.id, content, ...extra } });
    expect((await publish({ type: "thought", body: "Looking into it" })).body.data.agentActivityCreate).toMatchObject({
      success: true,
      agentActivity: { content: { __typename: "AgentActivityThoughtContent", body: "Looking into it" } },
    });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("active");
    await publish({ type: "elicitation", body: "Which browser version?" });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("awaitingInput");
    await publish({ type: "response", body: "Working on it" }, { signal: "continue" });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("active");
    await publish({ type: "response", body: "Fixed in #12" });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("complete");
    expect(
      (await get(`/agent-sessions/${session.id}/activities`)).map((activity: { type: string }) => activity.type),
    ).toEqual(["thought", "elicitation", "response", "response"]);
    expect(await get(`/issues/${created.id}/delegate`)).toMatchObject({ id: app.id, kind: "app" });
  });

  test("Linear refuses what it documents as refused, and nothing changes", async () => {
    const { ana, app, post, get, gql, issue } = await workspace();
    const session = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: (await issue()).id });
    const publish = async (content: object, extra: object = {}) =>
      (await gql(ACTIVITY, { input: { agentSessionId: session.id, content, ...extra } })).body.errors?.[0]?.message;
    expect(await publish({ type: "prompt", body: "hi" })).toBe("Only a user can publish a prompt activity");
    expect(await publish({ type: "thought" })).toBe("A thought needs a body");
    expect(await publish({ type: "action", action: "Searching" })).toBe("An action needs action and parameter");
    expect(await publish({ type: "response", body: "x" }, { ephemeral: true })).toBe(
      "Only thought and action activities can be ephemeral",
    );
    expect(await publish({ type: "thought", body: "x" }, { signal: "stop" })).toBe(
      "The stop signal is reserved for users",
    );
    expect(await publish({ type: "thought", body: "x" }, { signal: "continue" })).toBe(
      "Use continue only with a response",
    );
    expect(await get(`/agent-sessions/${session.id}/activities`)).toEqual([]);
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("pending");
  });

  test("a mention in a comment opens a session on its thread; a reply there prompts it", async () => {
    const { h, ana, post, get, gql, webhooks, issue } = await workspace();
    const created = await issue();
    const comment = await post(`/users/${ana.id}/comment`, {
      body: "@my-agent can you take a look?",
      issue: created.id,
    });
    expect(comment.body).toBe("@my-agent can you take a look?");
    expect(comment.session).toBeDefined();
    await gql(ACTIVITY, {
      input: { agentSessionId: comment.session.id, content: { type: "response", body: "On it" } },
    });
    const reply = await post(`/users/${ana.id}/reply`, { body: "and the docs too", comment: comment.id });
    await h.app.settled();
    expect(reply.session?.id).toBe(comment.session.id);
    const prompted = webhooks().filter((hook) => hook.payload.action === "prompted");
    expect(prompted.at(-1)?.payload).toMatchObject({
      agentActivity: { content: { type: "prompt", body: "and the docs too" }, sourceCommentId: reply.id },
    });
    // The new turn waits for the agent again.
    expect(await get(`/agent-sessions/${comment.session.id}/state`)).toBe("pending");
    // The comment's Markdown has the app's profile link, as Linear writes a mention.
    const created2 = webhooks().find((hook) => hook.event === "Comment");
    expect(created2?.payload.data.body).toMatch(/\/acme\/profiles\/my-agent can you take a look\?$/);
    expect((await get(`/issues/${created.id}/transcript`)).text).toBe(
      [
        "Ana: Checkout fails on Safari",
        "Ana: @my-agent can you take a look?",
        "  my-agent: On it",
        "  Ana: and the docs too",
      ].join("\n"),
    );
  });

  test("Stop: the session is stopping until the agent ends its turn", async () => {
    const { h, ana, app, post, get, gql, webhooks, issue } = await workspace();
    const session = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: (await issue()).id });
    await gql(ACTIVITY, { input: { agentSessionId: session.id, content: { type: "thought", body: "Refactoring" } } });
    await post(`/users/${ana.id}/stop`, { session: session.id });
    await h.app.settled();
    expect(webhooks().at(-1)?.payload).toMatchObject({ action: "prompted", agentActivity: { signal: "stop" } });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("stopping");
    await gql(ACTIVITY, { input: { agentSessionId: session.id, content: { type: "thought", body: "Still going" } } });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("stopping");
    await gql(ACTIVITY, { input: { agentSessionId: session.id, content: { type: "response", body: "Stopped" } } });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("complete");
  });

  test("a plan and links: what agentSessionUpdate takes, and that it acknowledges a pending session", async () => {
    const { ana, app, post, get, gql, issue } = await workspace();
    const session = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: (await issue()).id });
    const update = (input: object) =>
      gql(
        `mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success agentSession { status plan externalUrls externalLinks { label url } } } }`,
        { id: session.id, input },
      );
    const answer = await update({
      plan: [
        { content: "Find the bug", status: "inProgress" },
        { content: "Fix it", status: "pending" },
      ],
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/web/pull/12" }],
    });
    expect(answer.body.data.agentSessionUpdate.agentSession).toMatchObject({
      status: "active",
      plan: {
        entries: [
          { content: "Find the bug", status: "inProgress" },
          { content: "Fix it", status: "pending" },
        ],
      },
      externalLinks: [{ label: "Pull request", url: "https://github.com/acme/web/pull/12" }],
    });
    expect(JSON.parse(answer.body.data.agentSessionUpdate.agentSession.externalUrls)).toHaveLength(1);
    expect(await get(`/agent-sessions/${session.id}/plan`)).toHaveLength(2);
    expect(await get(`/agent-sessions/${session.id}/external-urls`)).toEqual([
      { label: "Pull request", url: "https://github.com/acme/web/pull/12" },
    ]);
    expect((await update({ plan: [{ content: "x", status: "done" }] })).body.errors[0].message).toMatch(
      /plan must be a list/,
    );
    expect((await update({ addedExternalUrls: [{ label: "x", url: "ftp://x" }] })).body.errors[0].message).toMatch(
      /HTTP or HTTPS/,
    );
  });
});

describe("the GraphQL API", () => {
  test("only the app's OAuth token, and the root fields an agent uses", async () => {
    const { gql, team, issue, get } = await workspace();
    const created = await issue();
    expect((await gql("{ viewer { id } }", {}, null)).status).toBe(401);
    expect((await gql("{ viewer { id } }", {}, "lin_api_someoneelse")).body.errors[0].extensions.code).toBe(
      "AUTHENTICATION_ERROR",
    );
    const viewer = (await gql("{ viewer { id name app } organization { name urlKey } }")).body.data;
    expect(viewer).toMatchObject({
      viewer: { name: "my-agent", app: true },
      organization: { name: "Acme", urlKey: "acme" },
    });
    const read = await gql(
      `query ($id: String!) { issue(id: $id) { identifier title priorityLabel team { key states { nodes { name type } } } state { name type } labels { nodes { name } } } }`,
      { id: "ENG-1" },
    );
    expect(read.body.data.issue).toMatchObject({
      identifier: "ENG-1",
      team: { key: "ENG" },
      state: { name: "Backlog", type: "backlog" },
    });
    expect(read.body.data.issue.team.states.nodes.map((state: { name: string }) => state.name)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);
    const states = await gql(
      `query ($team: ID) { workflowStates(filter: { team: { id: { eq: $team } }, name: { eq: "In Review" } }) { nodes { id name } } }`,
      { team: team.id },
    );
    const [review] = states.body.data.workflowStates.nodes;
    await gql(
      `mutation ($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`,
      { id: created.id, state: review.id },
    );
    expect(await get(`/issues/${created.id}/state`)).toEqual({ name: "In Review", type: "started" });
    expect((await gql("{ nope }")).status).toBe(400);
    expect((await gql(`{ issue(id: "ENG-99") { id } }`)).body.errors[0].message).toBe("Entity not found: Issue");
    const calls = await get("/calls");
    expect(calls.map((call: { operation: string }) => call.operation)).toContain("issueUpdate");
  });

  test("a comment the app writes, and an Issue event with what changed", async () => {
    const { h, gql, webhooks, issue, get } = await workspace();
    const created = await issue();
    await gql(
      `mutation ($issue: String!) { commentCreate(input: { issueId: $issue, body: "Looking" }) { success comment { id body user { name } } } }`,
      { issue: created.id },
    );
    await gql(
      `mutation ($id: String!) { issueUpdate(id: $id, input: { title: "Checkout fails", priority: 2 }) { success issue { title priority } } }`,
      { id: created.id },
    );
    await h.app.settled();
    const update = webhooks().find((hook) => hook.event === "Issue" && hook.payload.action === "update");
    expect(update?.payload).toMatchObject({
      data: { title: "Checkout fails", priority: 2 },
      updatedFrom: { title: "Checkout fails on Safari", priority: 0 },
    });
    expect(
      (await get(`/issues/${created.id}/comments`)).map((comment: { author: { name: string }; body: string }) => [
        comment.author.name,
        comment.body,
      ]),
    ).toEqual([["my-agent", "Looking"]]);
  });
});

describe("webhooks", () => {
  test("signed over the exact bytes, with the time inside the body; a redelivery is stamped and signed again", async () => {
    const { h, agent, ana, app, post, issue } = await workspace();
    const session = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: (await issue()).id });
    await h.app.settled();
    const [first] = agent.received.filter((hook) => hook.headers["linear-event"] === "AgentSessionEvent");
    const sign = (body: string) => createHmac("sha256", app.webhookSecret).update(body).digest("hex");
    expect(first?.headers["linear-signature"]).toBe(sign(first?.body ?? ""));
    expect(first?.headers["linear-delivery"]).toBe(session.delivery.id);
    const stamped = JSON.parse(first?.body ?? "{}").webhookTimestamp;
    expect(Math.abs(stamped - Date.now())).toBeLessThan(5000);

    h.clock.advance(90_000);
    await post(`/deliveries/${session.delivery.id}/redeliver`);
    await h.app.settled();
    const again = agent.received.at(-1);
    expect(JSON.parse(again?.body ?? "{}").webhookTimestamp).toBeGreaterThan(stamped + 89_000);
    expect(again?.headers["linear-signature"]).toBe(sign(again?.body ?? ""));

    await post(`/deliveries/${session.delivery.id}/resend`, { stale: true });
    await h.app.settled();
    const stale = agent.received.at(-1);
    expect(JSON.parse(stale?.body ?? "{}").webhookTimestamp).toBeLessThan(Date.now() + 90_000 - 100_000);
    expect(stale?.headers["linear-signature"]).toBe(sign(stale?.body ?? ""));
  });
});

describe("what people may do", () => {
  test("a guest acts only in teams they are in; a state or label must be the team's", async () => {
    const { ana, post, team, issue } = await workspace();
    const guest = await post("/users", { name: "Gus", guest: true });
    const created = await issue();
    expect(await refusal(post(`/users/${guest.id}/comment`, { body: "hi", issue: created.id }))).toBe("forbidden");
    expect(await refusal(post(`/users/${ana.id}/set-state`, { state: "Nope", issue: created.id }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/label`, { labels: ["nope"], issue: created.id }))).toBe("not_found");
    expect(await refusal(post("/teams", { key: "ENG" }))).toBe("invalid_argument");
    expect(await refusal(post("/teams", { key: "eng" }))).toBe("invalid_argument");
    expect(team.key).toBe("ENG");
  });
});
