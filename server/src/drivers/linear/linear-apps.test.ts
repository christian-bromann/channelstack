/**
 * Exit check 12.3 for Linear: several apps in one workspace (decision 0027). Each is an OAuth app
 * installed with `actor=app`, with its own app user, token, client and webhook secret, and its own
 * webhook URL. Agent sessions are per app; `Issue` and `Comment` webhooks go to every subscribed
 * app, each signed with its own secret. What is still to confirm between apps (B4, B6) the fake
 * refuses, as the decision says.
 */
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal, watchCredentials } from "../../../test/app-harness.ts";
import { linearWebhookProblems } from "../../../test/schemas/linear.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  const done = agents.splice(0);
  for (const agent of done) agent.close();
  // Every webhook any app got, whichever test looked at it, holds to Linear's schema.
  const problems = done.flatMap((agent) =>
    agent.received.flatMap(({ headers, body }) =>
      linearWebhookProblems(String(headers["linear-event"]), JSON.parse(body)),
    ),
  );
  expect(problems.join("\n")).toBe("");
});

/** A workspace with my-agent at one endpoint and `coder` at another, and Ana in a team. `watcher`, if made, has a third. */
async function twoApps() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  const watching = await recordingAgent();
  agents.push(mine, theirs, watching);
  const urls: Record<string, string> = { coder: theirs.url, watcher: watching.url };
  const h = harness({ linear: mine.url }, { appWebhooks: (_driver, app) => urls[app] });
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/linear`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const app = (await get("")).app;
  const coder = await post("/apps", { name: "coder" });
  const ana = await post("/users", { name: "Ana" });
  const team = await post("/teams", { key: "ENG", members: [ana.id] });
  const issue = (extra: object = {}) =>
    post(`/users/${ana.id}/issues`, { issue: { title: "Checkout fails on Safari", ...extra }, team: team.id });
  /** A GraphQL operation, as the app whose token it is sends it. */
  const gql = async (token: string, query: string, variables: Record<string, unknown> = {}) =>
    (await h.provider("POST", "linear/graphql", { query, variables }, token)).body;
  return {
    h,
    sessionId: sessionId as string,
    mine,
    theirs,
    watching,
    base,
    post,
    get,
    app,
    coder,
    ana,
    team,
    issue,
    gql,
  };
}

/** What an agent received: each webhook's event header and parsed body. */
const hooks = (agent: RecordingAgent) =>
  agent.received.map(({ headers, body }) => ({ event: String(headers["linear-event"]), payload: JSON.parse(body) }));

const ACTIVITY = `mutation Publish($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

describe("exit check 12.3: Linear apps", () => {
  test("an app has its own app user, token, client and webhook secret, and the same name gives the same app", async () => {
    const { h, post, get, app, coder } = await twoApps();
    expect(coder).toMatchObject({ name: "coder", kind: "app", botUserId: coder.id });
    expect(coder.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(coder.accessToken).toMatch(/^lin_oauth_[a-f0-9]{64}$/);
    expect(coder.webhookSecret).toMatch(/^lin_wh_/);
    for (const key of ["id", "accessToken", "webhookSecret", "clientId", "clientSecret"]) {
      expect(coder[key]).not.toBe(app[key]);
    }
    expect(coder.accessToken).toBe(h.secrets.forApp("linear", "coder", "oauthToken"));
    expect(await post("/apps", { name: "coder" })).toEqual(coder);
    expect((await get("/apps")).map((one: { name: string }) => one.name)).toEqual(["my-agent", "coder"]);
    expect(await refusal(post("/apps", { name: "coder", events: ["Issue"] }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
  });

  test("each token answers as its own app: viewer, isMe, and who writes", async () => {
    const { gql, app, coder, issue } = await twoApps();
    const who = `{ viewer { id name isMe } users { nodes { id isMe app } } }`;
    const asCoder = await gql(coder.accessToken, who);
    expect(asCoder.data.viewer).toEqual({ id: coder.id, name: "coder", isMe: true });
    expect(
      asCoder.data.users.nodes.filter((user: { app: boolean }) => user.app).map((user: { id: string }) => user.id),
    ).toEqual([app.id, coder.id]);
    expect((await gql(app.accessToken, who)).data.viewer).toMatchObject({ id: app.id, isMe: true });
    expect((await gql("lin_oauth_nope", who)).errors[0].extensions.code).toBe("AUTHENTICATION_ERROR");

    const created = await issue();
    const written = await gql(
      coder.accessToken,
      `mutation { commentCreate(input: { issueId: "${created.id}", body: "on it" }) { comment { user { id } } } }`,
    );
    expect(written.data.commentCreate.comment.user.id).toBe(coder.id);
  });

  test("delegating to an app opens that app's session, and only it hears AgentSessionEvent", async () => {
    const { h, mine, theirs, post, get, coder, ana, issue } = await twoApps();
    const created = await issue();
    const session = await post(`/users/${ana.id}/delegate`, { app: coder.id, issue: created.id });
    await h.app.settled();

    expect(session.app).toMatchObject({ id: coder.id, name: "coder" });
    expect(session.delivery).toMatchObject({ app: "coder", type: "AgentSessionEvent", action: "created" });
    const opened = hooks(theirs).find((hook) => hook.event === "AgentSessionEvent");
    expect(opened?.payload).toMatchObject({
      action: "created",
      appUserId: coder.id,
      oauthClientId: coder.clientId,
      agentSession: {
        id: session.id,
        appUserId: coder.id,
        comment: { body: "This thread is for an agent session with coder." },
      },
    });
    expect(linearWebhookProblems("AgentSessionEvent", opened?.payload)).toEqual([]);
    expect(hooks(mine).some((hook) => hook.event === "AgentSessionEvent")).toBe(false);
    // The delegation itself is an Issue change both apps hear.
    expect(hooks(mine).map((hook) => hook.event)).toEqual(["Issue", "Issue"]);
    expect(await get(`/issues/${created.id}/delegate`)).toMatchObject({ id: coder.id, kind: "app" });

    // Ana's turns in coder's session go to coder alone, Stop included.
    await post(`/users/${ana.id}/prompt`, { body: "use the staging data", session: session.id });
    await post(`/users/${ana.id}/stop`, { session: session.id });
    await h.app.settled();
    const prompted = hooks(theirs).filter((hook) => hook.payload.action === "prompted");
    expect(prompted.map((hook) => hook.payload.agentActivity.signal)).toEqual([null, "stop"]);
    expect(hooks(mine).some((hook) => hook.event === "AgentSessionEvent")).toBe(false);
  });

  test("an issue created delegated to an app opens its session; delegating to another app moves it", async () => {
    const { h, theirs, mine, post, get, app, coder, ana, issue } = await twoApps();
    const created = await issue({ delegate: coder.id });
    await h.app.settled();
    expect((await get(`/issues/${created.id}/session`)).app.id).toBe(coder.id);
    expect(hooks(theirs).filter((hook) => hook.event === "AgentSessionEvent")).toHaveLength(1);

    const moved = await post(`/users/${ana.id}/delegate`, { app: app.id, issue: created.id });
    await h.app.settled();
    expect(moved.app.id).toBe(app.id);
    expect(await get(`/issues/${created.id}/delegate`)).toMatchObject({ id: app.id });
    expect(hooks(mine).filter((hook) => hook.event === "AgentSessionEvent")).toHaveLength(1);
    expect(await refusal(post(`/users/${ana.id}/delegate`, { app: "reviewer", issue: created.id }))).toBe("not_found");
  });

  test("a person's @mention of an app opens a session for that app alone; a reply in its thread prompts it", async () => {
    const { h, mine, theirs, post, coder, ana, issue } = await twoApps();
    const created = await issue();
    const mention = await post(`/users/${ana.id}/comment`, { body: "@coder can you take this?", issue: created.id });
    await h.app.settled();

    expect(mention.session.app.id).toBe(coder.id);
    expect(
      hooks(theirs)
        .filter((hook) => hook.event === "AgentSessionEvent")
        .map((hook) => hook.payload.action),
    ).toEqual(["created"]);
    expect(hooks(mine).some((hook) => hook.event === "AgentSessionEvent")).toBe(false);

    const reply = await post(`/users/${ana.id}/reply`, { body: "it's the checkout page", comment: mention.id });
    await h.app.settled();
    expect(reply.session.id).toBe(mention.session.id);
    expect(hooks(theirs).filter((hook) => hook.payload.action === "prompted")).toHaveLength(1);
    expect(hooks(mine).some((hook) => hook.event === "AgentSessionEvent")).toBe(false);
  });

  test("an app can't publish into or update another app's session (Linear's error to confirm, B4)", async () => {
    const { h, gql, post, app, coder, ana, issue, get } = await twoApps();
    const session = await post(`/users/${ana.id}/delegate`, { app: coder.id, issue: (await issue()).id });
    const thought = { agentSessionId: session.id, content: { type: "thought", body: "Looking" } };

    const refused = await gql(app.accessToken, ACTIVITY, { input: thought });
    expect(refused.errors[0].extensions.code).toBe("FORBIDDEN");
    const update = await gql(
      app.accessToken,
      `mutation { agentSessionUpdate(id: "${session.id}", input: { summary: "mine" }) { success } }`,
    );
    expect(update.errors[0].extensions.code).toBe("FORBIDDEN");
    expect((await gql(app.accessToken, `{ agentSessions { nodes { id } } }`)).data.agentSessions.nodes).toEqual([]);

    expect((await gql(coder.accessToken, ACTIVITY, { input: thought })).data.agentActivityCreate.success).toBe(true);
    const answer = { agentSessionId: session.id, content: { type: "response", body: "Fixed in #12" } };
    await gql(coder.accessToken, ACTIVITY, { input: answer });
    await h.app.settled();
    const activities = await get(`/agent-sessions/${session.id}/activities`);
    expect(activities.at(-1)).toMatchObject({ type: "response", author: { id: coder.id, kind: "app" } });
    expect(await get(`/agent-sessions/${session.id}/state`)).toBe("complete");
  });

  test("A1: Issue and Comment webhooks go to every app, each its own delivery signed with its own app's secret", async () => {
    const { h, mine, theirs, post, base, app, coder, ana, issue } = await twoApps();
    const created = await issue();
    const comment = await post(`/users/${ana.id}/comment`, { body: "Seen on iOS 18 too", issue: created.id });
    await h.app.settled();

    expect(hooks(mine).map((hook) => hook.event)).toEqual(["Issue", "Comment"]);
    expect(hooks(theirs).map((hook) => hook.event)).toEqual(["Issue", "Comment"]);
    const [mineComment, theirsComment] = [hooks(mine)[1]?.payload, hooks(theirs)[1]?.payload];
    expect(mineComment.data.id).toBe(theirsComment.data.id);
    expect(mineComment.webhookId).not.toBe(theirsComment.webhookId);
    expect(linearWebhookProblems("Comment", theirsComment)).toEqual([]);

    // Linear's own receiver: each app's accepts its delivery and refuses the other app's.
    const receiver = (secret: string) => new LinearWebhookClient(secret);
    const verifies = (secret: string) => (delivery: RecordingAgent["received"][number]) => {
      try {
        return receiver(secret).verify(Buffer.from(delivery.body), String(delivery.headers["linear-signature"]));
      } catch {
        return false;
      }
    };
    expect(mine.received.every(verifies(app.webhookSecret))).toBe(true);
    expect(theirs.received.every(verifies(coder.webhookSecret))).toBe(true);
    // Each delivery fails against the other app's secret, not only one of them.
    expect(theirs.received.some(verifies(app.webhookSecret))).toBe(false);
    expect(mine.received.some(verifies(coder.webhookSecret))).toBe(false);

    // The comment's delivery is the built-in app's; another app's is asked for by app.
    expect(comment.delivery).toMatchObject({ app: "my-agent", type: "Comment", action: "create" });
    const forCoder = (await h.call("GET", `${base}/comments/${comment.id}/delivery-for?app=${coder.id}`)).body;
    expect(forCoder).toMatchObject({
      app: "coder",
      type: "Comment",
      action: "create",
      webhookId: theirsComment.webhookId,
    });
    const deliveries = (await h.call("GET", `${base}/deliveries`)).body as { app: string }[];
    expect(new Set(deliveries.map((one) => one.app))).toEqual(new Set(["my-agent", "coder"]));
  });

  test("another app's change reaches the app with that app's user as the actor (its shape to confirm, B5)", async () => {
    const { h, mine, gql, coder, issue } = await twoApps();
    const created = await issue();
    await gql(
      coder.accessToken,
      `mutation { commentCreate(input: { issueId: "${created.id}", body: "on it" }) { success } }`,
    );
    await gql(coder.accessToken, `mutation { issueUpdate(id: "${created.id}", input: { priority: 2 }) { success } }`);
    await h.app.settled();

    const [comment, update] = hooks(mine).slice(1);
    expect(comment?.payload).toMatchObject({
      type: "Comment",
      action: "create",
      actor: { id: coder.id, name: "coder" },
    });
    expect(update?.payload).toMatchObject({ type: "Issue", action: "update", actor: { id: coder.id } });
  });

  test("B6, until answered: an app's mention of another app, and its delegating to one, are refused", async () => {
    const { h, mine, theirs, gql, post, app, coder, ana, issue } = await twoApps();
    const created = await issue();
    // A person's mention opens my-agent's session; its Markdown is how an app would write one.
    const mention = await post(`/users/${ana.id}/comment`, { body: "context for @my-agent", issue: created.id });
    await h.app.settled();
    expect(mention.session.app.id).toBe(app.id);
    const before = theirs.received.length + mine.received.length;

    const markdown = hooks(mine).find((hook) => hook.event === "Comment")?.payload.data.body as string;
    expect(markdown).toMatch(/\/profiles\/my-agent/);
    const asCoder = await gql(
      coder.accessToken,
      `mutation C($body: String!) { commentCreate(input: { issueId: "${created.id}", body: $body }) { success } }`,
      { body: markdown },
    );
    expect(asCoder.errors[0].extensions.code).toBe("INPUT_ERROR");
    expect(
      await refusal(post(`/apps/${coder.id}/comment`, { body: "@my-agent please review", issue: created.id })),
    ).toBe("invalid_argument");
    const delegating = await gql(
      coder.accessToken,
      `mutation { issueUpdate(id: "${created.id}", input: { delegateId: "${app.id}" }) { success } }`,
    );
    expect(delegating.errors[0].extensions.code).toBe("INPUT_ERROR");
    await h.app.settled();
    expect(theirs.received.length + mine.received.length).toBe(before);
  });

  test("an app's token and secrets come with its handle only: no author, delegate or session's app holds them", async () => {
    const { h, base, post, get, gql, app, coder, ana, issue } = await twoApps();
    const watch = watchCredentials(h, "linear");
    const created = await issue();
    const session = await post(`/users/${ana.id}/delegate`, { app: coder.id, issue: created.id });
    const said = await post(`/apps/${coder.id}/comment`, { body: "I'll take the backend", issue: created.id });
    await post(`/apps/coder/reply`, { body: "PR is up", comment: said.id });
    const thought = { agentSessionId: session.id, content: { type: "thought", body: "Looking" } };
    await gql(coder.accessToken, ACTIVITY, { input: thought });
    await h.app.settled();
    const reads = [
      ...["", "/comments", "/delegate", "/sessions", "/session", "/transcript"].map(
        (read) => `/issues/${created.id}${read}`,
      ),
      `/comments/${said.id}/replies`,
      `/comments/${said.id}/transcript`,
      ...["/state", "/activities", "/transcript"].map((read) => `/agent-sessions/${session.id}${read}`),
    ];
    for (const read of reads) expect([read, (await h.call("GET", `${base}${read}`)).status]).toEqual([read, 200]);
    expect((await get("/apps")).map((one: { accessToken: string }) => one.accessToken)).toEqual([
      app.accessToken,
      coder.accessToken,
    ]);

    // The client id isn't a secret: Linear puts it in every AgentSessionEvent (`oauthClientId`), and deliveries show it.
    const secrets = [app, coder].flatMap((one) => [one.accessToken, one.webhookSecret, one.clientSecret]);
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);
    expect(watch.leaks(secrets)).toEqual([]);
  });

  test("a scripted app comments and replies through the fake's own path, as itself; never as my-agent", async () => {
    const { h, mine, post, get, app, coder, ana, issue } = await twoApps();
    const created = await issue();
    const said = await post(`/apps/${coder.id}/comment`, { body: "I'll take the backend", issue: created.id });
    const root = await post(`/users/${ana.id}/comment`, { body: "Thanks", issue: created.id });
    const replied = await post(`/apps/coder/reply`, { body: "PR is up", comment: root.id });
    await h.app.settled();

    expect(said.author).toMatchObject({ kind: "app", name: "coder", id: coder.id });
    expect(replied.author).toMatchObject({ kind: "app", id: coder.id });
    expect((await get(`/comments/${root.id}/replies`)).map((one: { body: string }) => one.body)).toEqual(["PR is up"]);
    const comments = hooks(mine).filter((hook) => hook.event === "Comment");
    expect(comments.map((hook) => hook.payload.actor.id)).toEqual([coder.id, ana.id, coder.id]);
    // A scripted app's comment opens no session, mentions or not.
    expect(said.session).toBeUndefined();

    expect(await refusal(post(`/apps/${app.id}/comment`, { body: "hi", issue: created.id }))).toBe("invalid_argument");
    expect(await refusal(post(`/apps/reviewer/comment`, { body: "hi", issue: created.id }))).toBe("not_found");
  });

  test("exit check 12.6: two apps commenting at each other on an issue are stopped at the guard's limit, and the session says so", async () => {
    const { h, sessionId, mine, post, coder, ana, issue } = await twoApps();
    const reviewer = await post("/apps", { name: "reviewer" });
    const created = await issue();
    const other = await issue({ title: "Another" });
    await post(`/users/${ana.id}/comment`, { body: "go", issue: created.id });
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      await post(`/apps/${i % 2 === 0 ? coder.id : reviewer.id}/comment`, { body: `turn ${i}`, issue: created.id });
    }
    await h.app.settled();
    const onIssue = (id: string) =>
      hooks(mine).filter((hook) => hook.event === "Comment" && hook.payload.data.issueId === id).length;

    // my-agent heard Ana, then each app comment up to the limit, and nothing after; the other issue goes on.
    expect(onIssue(created.id)).toBe(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(/^a bot loop in linear [0-9a-f-]{36} \(50 app messages .*coder → reviewer/),
    ]);
    await post(`/apps/${coder.id}/comment`, { body: "elsewhere", issue: other.id });
    // A person writing again starts the issue over.
    await post(`/users/${ana.id}/comment`, { body: "again", issue: created.id });
    await post(`/apps/${coder.id}/comment`, { body: "back", issue: created.id });
    await h.app.settled();
    expect(onIssue(created.id)).toBe(3 + LOOP_LIMIT);
    expect(onIssue(other.id)).toBe(1);
  });

  test("an app is assignable, and an app subscribed to fewer events hears only those", async () => {
    const { h, watching, post, gql, app, coder, ana, issue } = await twoApps();
    const created = await issue();
    // my-agent assigns the issue to coder's app user, as an agent would.
    const assigned = await gql(
      app.accessToken,
      `mutation { issueUpdate(id: "${created.id}", input: { assigneeId: "${coder.id}" }) { issue { assignee { id app } } } }`,
    );
    expect(assigned.data.issueUpdate.issue.assignee).toEqual({ id: coder.id, app: true });
    const assignedIssues = await gql(coder.accessToken, `{ viewer { assignedIssues { nodes { id } } } }`);
    expect(assignedIssues.data.viewer.assignedIssues.nodes).toEqual([{ id: created.id }]);

    await post("/apps", { name: "watcher", events: ["Issue"] });
    await post(`/users/${ana.id}/comment`, { body: "noted", issue: created.id });
    await post(`/users/${ana.id}/edit-issue`, { changes: { priority: 1 }, issue: created.id });
    await h.app.settled();
    expect(hooks(watching).map((hook) => `${hook.event}.${hook.payload.action}`)).toEqual(["Issue.update"]);
  });

  test("a person and an app of one session can't share a name", async () => {
    const { post } = await twoApps();
    expect(await refusal(post("/users", { name: "coder" }))).toBe("invalid_argument");
    expect(await refusal(post("/users", { name: "Coder Smith", displayName: "coder" }))).toBe("invalid_argument");
    await post("/users", { name: "Reviewer" });
    expect(await refusal(post("/apps", { name: "reviewer" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the app's lines under my-agent's keys", async () => {
    const { h, coder } = await twoApps();
    const env = (await h.call("GET", "/env?app=coder&channel=linear")).body;
    expect(env).toMatchObject({
      LINEAR_ACCESS_TOKEN: coder.accessToken,
      LINEAR_WEBHOOK_SECRET: coder.webhookSecret,
      LINEAR_CLIENT_ID: coder.clientId,
      LINEAR_CLIENT_SECRET: coder.clientSecret,
    });
    expect((await h.call("GET", "/env?app=my-agent&channel=linear")).body.LINEAR_ACCESS_TOKEN).toBe(
      h.secrets.get("linear", "oauthToken"),
    );
    // An app no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=reviewer&channel=linear")).body.LINEAR_ACCESS_TOKEN).toBe(
      h.secrets.forApp("linear", "reviewer", "oauthToken"),
    );
  });
});
