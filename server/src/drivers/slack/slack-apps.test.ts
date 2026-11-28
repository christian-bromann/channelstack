/**
 * Exit check 12.3 for Slack: several apps in one workspace (decision 0027). Each has its own bot
 * user, tokens and signing secret, its own request URL, and hears what the other apps do as
 * Slack sends it: their messages with `bot_id`, `app_id` and `bot_profile`, their mentions,
 * their reactions. What Slack refuses between bots, the fake refuses.
 */
import { isValidSlackRequest } from "@slack/bolt";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal } from "../../../test/app-harness.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/** A workspace with my-agent at one endpoint and `coder` at another. */
async function twoApps() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  agents.push(mine, theirs);
  const h = harness({ slack: mine.url }, { appWebhooks: (_driver, app) => (app === "coder" ? theirs.url : undefined) });
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const app = (await get("")).app;
  const coder = await post("/apps", { name: "coder" });
  const web = async (method: string, args: Record<string, unknown>, token: string) =>
    (await h.provider("POST", `slack/api/${method}`, args, token)).body;
  return { h, mine, theirs, base, post, get, app, coder, web, sessionId };
}

const events = (agent: RecordingAgent) =>
  agent.received.map((delivery) => JSON.parse(delivery.body) as { api_app_id: string; event: Record<string, unknown> });

describe("exit check 12.3: Slack apps", () => {
  test("an app has its own ids, tokens and signing secret, and the same name gives the same app", async () => {
    const { h, post, get, app, coder } = await twoApps();
    expect(coder).toMatchObject({ name: "coder", kind: "app", scopes: app.scopes });
    expect(coder.id).toMatch(/^A0[0-9A-Z]{9}$/);
    expect(coder.botUserId).toMatch(/^U0[0-9A-Z]{9}$/);
    expect(coder.botId).toMatch(/^B0[0-9A-Z]{9}$/);
    expect(coder.botToken).toMatch(/^xoxb-/);
    for (const key of ["id", "botUserId", "botId", "botToken", "appToken", "signingSecret"]) {
      expect(coder[key]).not.toBe(app[key]);
    }
    expect(coder.botToken).toBe(h.secrets.forApp("slack", "coder", "botToken"));
    expect(await post("/apps", { name: "coder" })).toEqual(coder);
    expect((await get("/apps")).map((one: { name: string }) => one.name)).toEqual(["my-agent", "coder"]);
    expect(await refusal(post("/apps", { name: "coder", scopes: ["chat:write"] }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
  });

  test("each token answers as its own app", async () => {
    const { web, app, coder } = await twoApps();
    expect(await web("auth.test", {}, coder.botToken)).toMatchObject({
      ok: true,
      user_id: coder.botUserId,
      bot_id: coder.botId,
    });
    expect(await web("auth.test", {}, app.botToken)).toMatchObject({ ok: true, user_id: app.botUserId });
    expect(await web("users.info", { user: coder.botUserId }, app.botToken)).toMatchObject({
      user: { id: coder.botUserId, is_bot: true, profile: { api_app_id: coder.id, bot_id: coder.botId } },
    });
  });

  test("another app's message reaches the app with bot_id, app_id and bot_profile, and no subtype; its own comes back to it", async () => {
    const { h, mine, theirs, post, app, coder, web } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });

    const sent = await web("chat.postMessage", { channel: channel.id, text: "opened #12" }, coder.botToken);
    await h.app.settled();

    expect(sent).toMatchObject({ ok: true });
    const [heard] = events(mine);
    expect(heard?.api_app_id).toBe(app.id);
    expect(heard?.event).toMatchObject({
      type: "message",
      user: coder.botUserId,
      bot_id: coder.botId,
      app_id: coder.id,
      bot_profile: { id: coder.botId, app_id: coder.id, name: "coder", user_id: coder.botUserId },
    });
    expect(heard?.event).not.toHaveProperty("subtype");
    // Slack sends an app its own messages too; Bolt's ignoreSelf drops them.
    const [own] = events(theirs);
    expect(own?.api_app_id).toBe(coder.id);
    expect(own?.event).toMatchObject({ type: "message", bot_id: coder.botId, app_id: coder.id });
  });

  test("a mention of one app goes to that app alone, with the writer's bot_id", async () => {
    const { h, mine, theirs, post, app, coder, web } = await twoApps();
    const channel = await post("/channels", { participants: [app.id, coder.id] });

    await web("chat.postMessage", { channel: channel.id, text: `<@${app.botUserId}> please review` }, coder.botToken);
    await h.app.settled();

    const mention = events(mine).find((one) => one.event.type === "app_mention");
    expect(mention?.event).toMatchObject({ user: coder.botUserId, bot_id: coder.botId });
    expect(events(theirs).some((one) => one.event.type === "app_mention")).toBe(false);
  });

  test("a person's message is one delivery per app that hears it, each signed with its own app's secret", async () => {
    const { h, mine, theirs, post, app, coder, base } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });

    const message = await post(`/users/${ana.id}/say`, { message: { text: "@coder fix it" }, channel: channel.id });
    await h.app.settled();

    // Bolt's own check, the one its receivers run on every request.
    const verifies = (secret: string) => (delivery: RecordingAgent["received"][number]) =>
      isValidSlackRequest({
        signingSecret: secret,
        body: delivery.body,
        headers: {
          "x-slack-signature": String(delivery.headers["x-slack-signature"]),
          "x-slack-request-timestamp": Number(delivery.headers["x-slack-request-timestamp"]),
        },
      });
    expect(mine.received.length).toBeGreaterThan(0);
    expect(theirs.received.length).toBeGreaterThan(0);
    expect(mine.received.every(verifies(app.signingSecret))).toBe(true);
    expect(theirs.received.every(verifies(coder.signingSecret))).toBe(true);
    // Each delivery fails against the other app's secret, not only one of them.
    expect(theirs.received.some(verifies(app.signingSecret))).toBe(false);
    expect(mine.received.some(verifies(coder.signingSecret))).toBe(false);
    expect(events(theirs).map((one) => one.event.type)).toEqual(["app_mention", "message"]);
    expect(events(mine).map((one) => one.event.type)).toEqual(["message"]);
    // The message's delivery is the built-in app's; another app's is asked for by app.
    expect(message.delivery).toMatchObject({ app: "my-agent", eventType: "message" });
    const forCoder = (
      await h.call("GET", `${base}/conversations/${channel.id}/messages/${message.ts}/delivery-for?app=${coder.id}`)
    ).body;
    expect(forCoder).toMatchObject({ app: "coder", eventType: "app_mention" });
    const deliveries = (await h.call("GET", `${base}/deliveries`)).body as { app: string }[];
    expect(new Set(deliveries.map((one) => one.app))).toEqual(new Set(["my-agent", "coder"]));
  });

  test("a bot can't open a DM with another bot", async () => {
    const { web, post, app, coder } = await twoApps();
    expect(await web("conversations.open", { users: app.botUserId }, coder.botToken)).toMatchObject({
      ok: false,
      error: "cannot_dm_bot",
    });
    const bot = await post("/users", { name: "deploy-bot", bot: true });
    expect(await refusal(post(`/apps/${coder.id}/say`, { message: { text: "hi" }, to: [bot.id] }))).toBe(
      "cannot_dm_bot",
    );
  });

  test("a scripted app writes, replies and reacts as its own calls would, where it is a member; never as my-agent", async () => {
    const { h, mine, post, app, coder } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    const elsewhere = await post("/channels", { participants: [ana.id, app.id] });

    const said = await post(`/apps/${coder.id}/say`, { message: { text: "@my-agent done" }, channel: channel.id });
    const replied = await post(`/apps/${coder.id}/reply`, { message: { text: "details" }, thread: said.thread });
    await post(`/apps/${coder.id}/react`, { emoji: "eyes", message: { channel: channel.id, ts: said.ts } });
    await h.app.settled();

    expect(said.author).toMatchObject({ kind: "app", name: "coder", id: coder.id });
    expect(replied.threadTs).toBe(said.ts);
    expect(said.delivery).toMatchObject({ app: "my-agent", eventType: "app_mention" });
    expect(events(mine).map((one) => one.event.type)).toEqual(["app_mention", "message", "message", "reaction_added"]);
    expect(events(mine)[3]?.event).toMatchObject({ user: coder.botUserId, reaction: "eyes" });
    expect(await refusal(post(`/apps/${coder.id}/say`, { message: { text: "hi" }, channel: elsewhere.id }))).toBe(
      "not_in_channel",
    );
    expect(await refusal(post(`/apps/${app.id}/say`, { message: { text: "hi" }, channel: channel.id }))).toBe(
      "invalid_argument",
    );
  });

  test("a button on another app's message is that app's: the click goes to it alone, and it answers as itself", async () => {
    const { h, mine, theirs, post, app, coder, web } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", action_id: "merge", text: { type: "plain_text", text: "Merge" } }],
      },
    ];
    const ask = await web("chat.postMessage", { channel: channel.id, text: "Merge #12?", blocks }, coder.botToken);
    await h.app.settled();
    const before = mine.received.length;

    await post(`/users/${ana.id}/click`, { button: { label: "Merge" }, message: { channel: channel.id, ts: ask.ts } });
    await h.app.settled();

    expect(mine.received.length).toBe(before);
    const click = theirs.received.at(-1);
    const payload = JSON.parse(new URLSearchParams(click?.body).get("payload") ?? "{}");
    expect(payload).toMatchObject({ type: "block_actions", api_app_id: coder.id, actions: [{ action_id: "merge" }] });
    expect(payload.token).toBe(h.secrets.forApp("slack", "coder", "verificationToken"));
  });

  test("exit check 12.6: two apps answering each other are stopped at the guard's limit, and the session says so", async () => {
    const { h, mine, post, app, coder, sessionId } = await twoApps();
    const reviewer = await post("/apps", { name: "reviewer" });
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id, reviewer.id] });
    await post(`/users/${ana.id}/say`, { message: { text: "go" }, channel: channel.id });
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      await post(`/apps/${i % 2 === 0 ? coder.id : reviewer.id}/say`, {
        message: { text: `turn ${i}` },
        channel: channel.id,
      });
    }
    await h.app.settled();

    // my-agent heard Ana, then each app message up to the limit, and nothing after.
    expect(mine.received.length).toBe(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(/^a bot loop in slack C0[0-9A-Z]+ was stopped after 50 app messages/),
    ]);
    // A person writing again starts the conversation over.
    await post(`/users/${ana.id}/say`, { message: { text: "again" }, channel: channel.id });
    await post(`/apps/${coder.id}/say`, { message: { text: "back" }, channel: channel.id });
    await h.app.settled();
    expect(mine.received.length).toBe(3 + LOOP_LIMIT);
  });

  test("Stop goes to the app streaming in the thread", async () => {
    const { h, mine, theirs, post, coder, web } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const msg = await post(`/users/${ana.id}/say`, { message: { text: "write a long report" }, to: [coder.id] });
    await web(
      "chat.startStream",
      { channel: msg.channel, thread_ts: msg.ts, markdown_text: "Working" },
      coder.botToken,
    );
    await h.app.settled();
    const before = mine.received.length;

    await post(`/users/${ana.id}/stop`, { thread: { channel: msg.channel, ts: msg.ts } });
    await h.app.settled();

    expect(mine.received.length).toBe(before);
    expect(events(theirs).at(-1)?.event).toMatchObject({ type: "agent_session_stopped", user: ana.id });
  });

  test("a person and an app of one session can't share a name", async () => {
    const { post } = await twoApps();
    expect(await refusal(post("/users", { name: "coder" }))).toBe("invalid_argument");
  });

  test("uninstalling one app leaves the other working", async () => {
    const { web, post, app, coder } = await twoApps();
    await post("/uninstall", { app: coder.id });
    expect(await web("auth.test", {}, coder.botToken)).toMatchObject({ ok: false, error: "account_inactive" });
    expect(await web("auth.test", {}, app.botToken)).toMatchObject({ ok: true });
  });

  test("exit check 12.5: channelstack env --app prints the app's lines under my-agent's keys", async () => {
    const { h, coder } = await twoApps();
    const env = (await h.call("GET", "/env?app=coder&channel=slack")).body;
    expect(env).toMatchObject({
      SLACK_BOT_TOKEN: coder.botToken,
      SLACK_APP_TOKEN: coder.appToken,
      SLACK_SIGNING_SECRET: coder.signingSecret,
    });
    expect((await h.call("GET", "/env?app=my-agent&channel=slack")).body.SLACK_BOT_TOKEN).toBe(
      h.secrets.get("slack", "botToken"),
    );
    // An app no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=reviewer&channel=slack")).body.SLACK_BOT_TOKEN).toBe(
      h.secrets.forApp("slack", "reviewer", "botToken"),
    );
    expect((await h.call("GET", "/env?app=Not_A_Name")).body.error).toBe("invalid_argument");
  });
});

describe("R1.12: deliveries, faults and the event log by app", () => {
  test("deliveries({ app }) lists one app's deliveries, by its handle or its name", async () => {
    const { h, post, get, app, coder, base } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    await post(`/users/${ana.id}/say`, { message: { text: "@coder fix it" }, channel: channel.id });
    await h.app.settled();

    const apps = (path: string) => get(path).then((list: { app: string }[]) => list.map((one) => one.app));
    expect(await apps(`/deliveries?app=${coder.id}`)).toEqual(["coder", "coder"]);
    expect(await apps("/deliveries?app=coder")).toEqual(["coder", "coder"]);
    expect(await apps(`/deliveries?app=${app.id}`)).toEqual(["my-agent"]);
    expect(await apps("/deliveries")).toHaveLength(3);
    expect((await h.call("GET", `${base}/deliveries?app=reviewer`)).body.error).toBe("not_found");
  });

  test("a fault that names an app is about that app's calls alone", async () => {
    const { post, app, coder, web } = await twoApps();
    const channel = await post("/channels", { participants: [app.id, coder.id] });
    await post("/faults", { type: "error", error: "internal_error", app: coder.id });

    expect(await web("chat.postMessage", { channel: channel.id, text: "hi" }, coder.botToken)).toMatchObject({
      ok: false,
      error: "internal_error",
    });
    expect(await web("chat.postMessage", { channel: channel.id, text: "hi" }, app.botToken)).toMatchObject({
      ok: true,
    });
  });

  test("the event log names the app a delivery went to, so tail and the inspector tell two apps apart", async () => {
    const { h, post, app, coder, sessionId } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    await post(`/users/${ana.id}/say`, { message: { text: "@coder fix it" }, channel: channel.id });
    await h.app.settled();

    const { events } = (await h.call("GET", `/sessions/${sessionId}/events`)).body as {
      events: Array<{ kind: string; data: { app?: string }; summary?: { text: string } }>;
    };
    expect(events.filter((event) => event.kind === "delivery").map((event) => event.data.app)).toEqual([
      "coder",
      "my-agent",
      "coder",
    ]);
    // The attempts are logged as each endpoint answers, so in no set order.
    expect(
      events
        .filter((event) => event.kind === "delivery_attempt")
        .map((event) => event.summary?.text)
        .sort(),
    ).toEqual(["→ slack app_mention to coder", "→ slack message", "→ slack message to coder"]);
  });
});
