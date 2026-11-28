/**
 * Exit check 12.3 for Slack: several apps in one workspace (decision 0027). Each has its own bot
 * user, tokens and signing secret, its own request URL, and hears what the other apps do as
 * Slack sends it: their messages with `bot_id`, `app_id` and `bot_profile`, their mentions,
 * their reactions. What Slack refuses between bots, the fake refuses.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal, watchCredentials } from "../../../test/app-harness.ts";
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

    const verifies = (agent: RecordingAgent, secret: string) =>
      agent.received.every((delivery) => {
        const timestamp = String(delivery.headers["x-slack-request-timestamp"]);
        const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${delivery.body}`).digest("hex");
        return delivery.headers["x-slack-signature"] === `v0=${signature}`;
      });
    expect(mine.received.length).toBeGreaterThan(0);
    expect(theirs.received.length).toBeGreaterThan(0);
    expect(verifies(mine, app.signingSecret)).toBe(true);
    expect(verifies(theirs, coder.signingSecret)).toBe(true);
    expect(verifies(theirs, app.signingSecret)).toBe(false);
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

  test("a modal another app opens is that app's: its trigger_id, updates, view_submission and view_closed are its alone", async () => {
    const { h, mine, theirs, post, get, app, coder, web } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", action_id: "form", text: { type: "plain_text", text: "Open form" } }],
      },
    ];
    await web("chat.postMessage", { channel: channel.id, text: "File a bug?", blocks }, coder.botToken);
    await h.app.settled();
    const view = {
      type: "modal",
      callback_id: "bug",
      notify_on_close: true,
      title: { type: "plain_text", text: "Bug" },
      submit: { type: "plain_text", text: "File" },
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "File it?" } }],
    };
    /** Ana clicks coder's button: the trigger_id coder is handed. */
    const click = async () => {
      await post(`/users/${ana.id}/click`, { button: { label: "Open form" }, channel: channel.id });
      await h.app.settled();
      return JSON.parse(new URLSearchParams(theirs.received.at(-1)?.body).get("payload") ?? "{}").trigger_id as string;
    };
    const payloadOf = (agent: RecordingAgent) =>
      JSON.parse(new URLSearchParams(agent.received.at(-1)?.body).get("payload") ?? "{}");
    const signedFor = (agent: RecordingAgent, secret: string) => {
      const delivery = agent.received.at(-1);
      const timestamp = String(delivery?.headers["x-slack-request-timestamp"]);
      const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${delivery?.body}`).digest("hex");
      return delivery?.headers["x-slack-signature"] === `v0=${signature}`;
    };
    const before = mine.received.length;

    // my-agent can't open a modal on the trigger_id coder was handed; coder can.
    const trigger = await click();
    expect(await web("views.open", { trigger_id: trigger, view }, app.botToken)).toMatchObject({
      ok: false,
      error: "invalid_trigger_id",
    });
    const opened = await web("views.open", { trigger_id: trigger, view }, coder.botToken);
    expect(opened).toMatchObject({ ok: true, view: { app_id: coder.id, bot_id: coder.botId } });

    // Only coder may update it.
    const update = { view_id: opened.view.id, view: { ...view, title: { type: "plain_text", text: "Bug!" } } };
    expect(await web("views.update", update, app.botToken)).toMatchObject({ ok: false, error: "not_found" });
    expect(await web("views.update", update, coder.botToken)).toMatchObject({ ok: true, view: { app_id: coder.id } });

    // Its submission goes to coder, signed with coder's secret, with coder's verification token.
    const submitted = await post(`/modals/${opened.view.id}/submit`);
    await h.app.settled();
    expect(submitted).toMatchObject({ type: "view_submission", app: "coder" });
    expect(payloadOf(theirs)).toMatchObject({
      type: "view_submission",
      api_app_id: coder.id,
      token: h.secrets.forApp("slack", "coder", "verificationToken"),
      view: { id: opened.view.id, app_id: coder.id },
    });
    expect(signedFor(theirs, coder.signingSecret)).toBe(true);

    // And its close.
    const again = await web("views.open", { trigger_id: await click(), view }, coder.botToken);
    const closed = await post(`/modals/${again.view.id}/close`);
    await h.app.settled();
    expect(closed).toMatchObject({ type: "view_closed", app: "coder" });
    expect(payloadOf(theirs)).toMatchObject({ type: "view_closed", api_app_id: coder.id });
    expect(signedFor(theirs, coder.signingSecret)).toBe(true);
    expect(mine.received.length).toBe(before);
    expect((await get(`/users/${ana.id}/modals`)).map((modal: { viewId: string }) => modal.viewId)).toEqual([
      opened.view.id,
      again.view.id,
    ]);
  });

  test("a slash command, a message shortcut and a split view reach the app they are for, and it answers as itself", async () => {
    const { h, mine, theirs, post, get, app, coder } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    const said = await post(`/users/${ana.id}/say`, { message: { text: "the build broke" }, channel: channel.id });
    await h.app.settled();
    const before = mine.received.length;
    theirs.received.length = 0;
    const form = () => new URLSearchParams(theirs.received.at(-1)?.body);

    // coder answers its command in the response itself.
    theirs.respond = () => ({
      status: 200,
      body: JSON.stringify({ text: "Deploying web" }),
      headers: { "content-type": "application/json" },
    });
    const command = await post(`/users/${ana.id}/commands`, {
      command: "/deploy web",
      channel: channel.id,
      app: "coder",
    });
    await h.app.settled();
    expect(command).toMatchObject({ type: "slash_command", app: "coder" });
    expect(Object.fromEntries(form())).toMatchObject({
      command: "/deploy",
      text: "web",
      api_app_id: coder.id,
      token: h.secrets.forApp("slack", "coder", "verificationToken"),
    });
    const answer = (await get(`/users/${ana.id}/ephemeral`)).at(-1);
    expect(answer).toMatchObject({ text: "Deploying web", author: { id: coder.id } });
    theirs.respond = () => ({ status: 200, body: "" });

    const shortcut = await post(`/users/${ana.id}/shortcut`, {
      callbackId: "file_bug",
      message: { channel: channel.id, ts: said.ts },
      app: coder.id,
    });
    await h.app.settled();
    expect(shortcut).toMatchObject({ type: "message_action", app: "coder" });
    expect(JSON.parse(form().get("payload") ?? "{}")).toMatchObject({
      type: "message_action",
      callback_id: "file_bug",
      api_app_id: coder.id,
    });

    const thread = await post(`/users/${ana.id}/agent-threads`, { from: channel.id, app: "coder" });
    await h.app.settled();
    expect(JSON.parse(theirs.received.at(-1)?.body ?? "{}").event).toMatchObject({
      type: "assistant_thread_started",
      assistant_thread: { user_id: ana.id, channel_id: thread.channel, context: { channel_id: channel.id } },
    });
    expect(await get(`/conversations/${thread.channel}/members`)).toEqual([
      expect.objectContaining({ id: ana.id }),
      expect.objectContaining({ id: coder.id }),
    ]);
    // None of it went to my-agent; without app, each is my-agent's as before.
    expect(mine.received.length).toBe(before);
    expect(await post(`/users/${ana.id}/commands`, { command: "/deploy", channel: channel.id })).toMatchObject({
      app: "my-agent",
    });
    expect(
      await refusal(post(`/users/${ana.id}/commands`, { command: "/x", channel: channel.id, app: "nobody" })),
    ).toBe("not_found");
  });

  test("a file is read as the app whose token asks: where its bot is a member, never where only another's is", async () => {
    const { h, theirs, post, app, coder, web } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const withCoder = await post("/channels", { participants: [ana.id, coder.id] });
    const withMine = await post("/channels", { participants: [ana.id, app.id] });
    const log = "Error: disk full\n";
    const share = (channel: string, path: string) =>
      post(`/users/${ana.id}/say`, {
        message: { text: "why does it crash?" },
        channel,
        files: [{ path, content: Buffer.from(log).toString("base64") }],
      });
    await share(withCoder.id, "coder.log");
    await share(withMine.id, "mine.log");
    await h.app.settled();
    const fileOf = (name: string) =>
      events(theirs)
        .flatMap((one) => (one.event.files as Array<{ id: string; name: string; url_private: string }>) ?? [])
        .find((file) => file.name === name);
    const theirsFile = fileOf("coder.log");
    if (!theirsFile) throw new Error("coder was told of the file in its channel");
    const download = async (url: string, token: string) =>
      (await h.app.fetch(new Request(url, { headers: { authorization: `Bearer ${token}` } }))).status;

    expect(await download(theirsFile.url_private, coder.botToken)).toBe(200);
    expect(await download(theirsFile.url_private, app.botToken)).toBe(404);
    expect(await web("files.info", { file: theirsFile.id }, coder.botToken)).toMatchObject({ ok: true });
    expect(await web("files.info", { file: theirsFile.id }, app.botToken)).toMatchObject({
      ok: false,
      error: "file_not_found",
    });

    // my-agent's file, in a channel coder isn't in, is my-agent's to read alone.
    const mine = (await web("conversations.history", { channel: withMine.id }, app.botToken)).messages[0].files[0];
    expect(await download(mine.url_private, app.botToken)).toBe(200);
    expect(await download(mine.url_private, coder.botToken)).toBe(404);
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

  test("exit check 12.6: the guard counts per thread; once stopped, app edits and reactions cause nothing, and a scripted bot doesn't start it over", async () => {
    const { h, mine, post, app, coder, web, sessionId } = await twoApps();
    const ana = await post("/users", { name: "Ana" });
    const robot = await post("/users", { name: "Robot", bot: true });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id, robot.id] });
    const loop = await post(`/users/${ana.id}/say`, { message: { text: "thread A" }, channel: channel.id });
    const other = await post(`/users/${ana.id}/say`, { message: { text: "thread B" }, channel: channel.id });
    const inThread = (ts: string) => () =>
      events(mine).filter((one) => one.event.type === "message" && one.event.thread_ts === ts).length;
    const inLoop = inThread(loop.ts);
    // coder and a scripted bot user answer each other in thread A; Ana writing in thread B doesn't start A over.
    let last: { ts: string } | undefined;
    for (let i = 0; i <= LOOP_LIMIT; i++) {
      const thread = { channel: channel.id, ts: loop.ts };
      if (i % 2 === 0) last = await post(`/apps/${coder.id}/reply`, { message: { text: `turn ${i}` }, thread });
      else await post(`/users/${robot.id}/reply`, { message: { text: `turn ${i}` }, thread });
      if (i === 10) await post(`/users/${ana.id}/reply`, { message: { text: "elsewhere" }, thread: other });
    }
    await h.app.settled();
    expect(inLoop()).toBe(LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(
        new RegExp(`^a bot loop in slack ${channel.id}/${loop.ts.replace(".", "\\.")} was stopped .*coder → Robot`),
      ),
    ]);
    if (!last) throw new Error("coder said nothing");

    // coder's edit and reaction in the stopped thread are kept, and cause nothing; the channel's top level goes on.
    const before = mine.received.length;
    expect(
      await web("chat.update", { channel: channel.id, ts: last.ts, text: "edited" }, coder.botToken),
    ).toMatchObject({ ok: true });
    expect(
      await web("reactions.add", { channel: channel.id, timestamp: last.ts, name: "eyes" }, coder.botToken),
    ).toMatchObject({ ok: true });
    await h.app.settled();
    expect(mine.received.length).toBe(before);
    await post(`/apps/${coder.id}/say`, { message: { text: "top level" }, channel: channel.id });
    await h.app.settled();
    expect(events(mine).at(-1)?.event).toMatchObject({ type: "message", text: "top level" });
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

  test("an app's tokens and signing secret come with its handle only: no author, member or reactor holds them", async () => {
    const { h, base, post, get, app, coder, web } = await twoApps();
    const watch = watchCredentials(h, "slack");
    const ana = await post("/users", { name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id] });
    const sent = await web("chat.postMessage", { channel: channel.id, text: "opened #12" }, coder.botToken);
    await web("reactions.add", { channel: channel.id, timestamp: sent.ts, name: "eyes" }, coder.botToken);
    await web("chat.postMessage", { channel: channel.id, thread_ts: sent.ts, text: "on it" }, app.botToken);
    await h.app.settled();
    const at = `/conversations/${channel.id}`;
    const reads = [
      `${at}/messages`,
      `${at}/members`,
      `${at}/latest`,
      `${at}/messages/${sent.ts}`,
      `${at}/threads/${sent.ts}/replies`,
      `${at}/messages/${sent.ts}/reactions`,
      `${at}/transcript`,
    ];
    for (const read of reads) expect([read, (await h.call("GET", `${base}${read}`)).status]).toEqual([read, 200]);
    expect((await get("/apps")).map((one: { botToken: string }) => one.botToken)).toEqual([
      app.botToken,
      coder.botToken,
    ]);

    const secrets = [app, coder].flatMap((one) => [one.botToken, one.appToken, one.signingSecret]);
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);
    expect(watch.leaks(secrets)).toEqual([]);
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
    // Attempts are logged as each agent answers, so in no fixed order.
    const attempts = events.filter((event) => event.kind === "delivery_attempt").map((event) => event.summary?.text);
    expect(attempts.toSorted()).toEqual([
      "→ slack app_mention to coder",
      "→ slack message",
      "→ slack message to coder",
    ]);
  });
});
