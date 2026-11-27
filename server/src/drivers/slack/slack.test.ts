import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { type Harness, harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/** A Slack workspace for one test: the app with an endpoint, and a session to act in. */
async function workspace(options: { agent?: boolean } = {}) {
  const agent = options.agent === false ? undefined : await recordingAgent();
  if (agent) agents.push(agent);
  const h = harness({ slack: agent?.url });
  return { h, agent, ...(await session(h)) };
}

async function session(h: Harness) {
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const fixture = (await h.call("GET", base)).body;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const user = (options: Record<string, unknown>) => post("/users", options);
  return { sessionId, base, fixture, app: fixture.app, post, get, user };
}

const events = (agent: RecordingAgent) => agent.received.map((delivery) => JSON.parse(delivery.body));
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => "no error",
    (error: { body?: { error: string } }) => error.body?.error,
  );

describe("the workspace", () => {
  test("the fixture describes the app with real-looking ids and its fake credentials", async () => {
    const { fixture, h } = await workspace({ agent: false });
    expect(fixture.app).toMatchObject({ name: "my-agent", kind: "app" });
    expect(fixture.app.id).toMatch(/^A0[0-9A-Z]{9}$/);
    expect(fixture.app.botUserId).toMatch(/^U0[0-9A-Z]{9}$/);
    expect(fixture.app.botId).toMatch(/^B0[0-9A-Z]{9}$/);
    expect(fixture.app.botToken).toBe(h.secrets.get("slack", "botToken"));
    expect(fixture.app.signingSecret).toBe(h.secrets.get("slack", "signingSecret"));
    expect(fixture.team.id).toMatch(/^T0[0-9A-Z]{9}$/);
    expect(fixture.apiUrl).toBe("http://127.0.0.1:4500/slack");
  });

  test("people and channels get Slack's id formats, and a channel a generated name", async () => {
    const { user, post } = await workspace({ agent: false });
    const ana = await user({ name: "Ana", admin: true });
    expect(ana).toMatchObject({ name: "Ana", displayName: "Ana", kind: "user", isAdmin: true, isBot: false });
    expect(ana.id).toMatch(/^U0[0-9A-Z]{9}$/);
    const channel = await post("/channels", { participants: [ana.id] });
    expect(channel.id).toMatch(/^C0[0-9A-Z]{9}$/);
    expect(channel).toMatchObject({ kind: "channel", name: expect.stringMatching(/^test-[0-9a-z]{6}$/) });
    expect((await post("/channels", { private: true })).kind).toBe("private_channel");
  });

  test("a session lists its people and its conversations, the one with the newest message last", async () => {
    const { user, post, get, app } = await workspace({ agent: false });
    const ana = await user({ name: "Ana" });
    const ben = await user({ name: "Ben" });
    const support = await post("/channels", { name: "support", participants: [ana.id, ben.id, app.id] });
    const random = await post("/channels", { name: "random", participants: [ana.id, ben.id] });
    expect((await get("/users")).map((person: { name: string }) => person.name)).toEqual(["Ana", "Ben"]);
    expect((await get(`/conversations/${support.id}/latest`)).error).toBe("not_found");

    const question = await post(`/users/${ana.id}/say`, { message: { text: "first" }, channel: random.id });
    await post(`/users/${ana.id}/say`, { message: { text: "second" }, channel: support.id });
    await post(`/users/${ben.id}/reply`, {
      message: { text: "a reply to the first" },
      thread: { channel: question.channel, ts: question.ts },
    });
    // The reply made #random the most recent again, and it is that conversation's newest message.
    expect((await get("/conversations")).map((conversation: { name: string }) => conversation.name)).toEqual([
      "support",
      "random",
    ]);
    expect(await get(`/conversations/${random.id}/latest`)).toMatchObject({
      text: "a reply to the first",
      threadTs: question.ts,
    });
  });

  test("decision 0006: names are unique per session, fixed ids are unique in the world", async () => {
    const { h, user, post } = await workspace({ agent: false });
    const other = await session(h);

    await post("/channels", { name: "support" });
    expect(await refusal(post("/channels", { name: "support" }))).toBe("name_taken");
    // Another session can have its own #support.
    expect((await other.post("/channels", { name: "support" })).name).toBe("support");

    expect((await user({ name: "Cara", id: "U0ADMIN01" })).id).toBe("U0ADMIN01");
    expect(await refusal(other.user({ name: "Cara", id: "U0ADMIN01" }))).toBe("invalid_argument");
    expect(await refusal(user({ name: "Dev", id: "not-an-id" }))).toBe("invalid_argument");
  });

  test("a fixed id is free again when the session that held it closes", async () => {
    const { h, user, sessionId } = await workspace({ agent: false });
    await user({ name: "Cara", id: "U0ADMIN01" });
    await h.call("DELETE", `/sessions/${sessionId}`);
    const next = await session(h);
    expect((await next.user({ name: "Cara", id: "U0ADMIN01" })).id).toBe("U0ADMIN01");
  });
});

describe("messages and the events they send", () => {
  test("a mention in a channel the app is in: app_mention and message, signed like Slack", async () => {
    const { h, agent, app, base, user, post, fixture } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });

    const message = await post(`/users/${ana.id}/say`, {
      message: { text: "@my-agent summarize #812" },
      channel: channel.id,
    });
    await h.app.settled();

    expect(message).toMatchObject({
      channel: channel.id,
      conversation: { id: channel.id, kind: "channel" },
      author: { id: ana.id, kind: "user" },
      text: `<@${app.botUserId}> summarize #812`,
      edited: false,
    });
    expect(message.ts).toMatch(/^\d{10}\.\d{6}$/);
    // When a message causes both, `delivery` is the app_mention one.
    expect(message.delivery).toMatchObject({ type: "event_callback", eventType: "app_mention" });
    expect(message.thread).toEqual({ channel: channel.id, ts: message.ts, conversation: message.conversation });
    const caused = (await h.call("GET", `${base}/conversations/${channel.id}/messages/${message.ts}/deliveries`)).body;
    expect(caused.map((delivery: { eventType: string }) => delivery.eventType)).toEqual(["app_mention", "message"]);

    const [mention, plain] = events(agent as RecordingAgent);
    expect(mention).toMatchObject({
      type: "event_callback",
      team_id: fixture.team.id,
      api_app_id: app.id,
      event_id: message.delivery.id,
      event: { type: "app_mention", user: ana.id, channel: channel.id, ts: message.ts, text: message.text },
      authorizations: [{ team_id: fixture.team.id, user_id: app.botUserId, is_bot: true }],
    });
    expect(mention.event_id).toMatch(/^Ev0[0-9A-Z]{9}$/);
    expect(plain.event).toMatchObject({ type: "message", channel_type: "channel", user: ana.id, ts: message.ts });
    expect(plain.event.blocks[0].elements[0].elements).toEqual([
      { type: "user", user_id: app.botUserId },
      { type: "text", text: " summarize #812" },
    ]);

    // Verify the way Slack's docs tell a receiver to.
    const delivery = (agent as RecordingAgent).received[0];
    const timestamp = String(delivery?.headers["x-slack-request-timestamp"]);
    const expected = createHmac("sha256", h.secrets.get("slack", "signingSecret"))
      .update(`v0:${timestamp}:${delivery?.body}`)
      .digest("hex");
    expect(delivery?.headers["x-slack-signature"]).toBe(`v0=${expected}`);
    expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(5);
  });

  test("the app hears nothing from a channel it isn't in, until it is invited", async () => {
    const { h, agent, app, user, post } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id] });

    const first = await post(`/users/${ana.id}/say`, {
      message: { text: "@my-agent are you here?" },
      channel: channel.id,
    });
    await h.app.settled();
    expect(first.delivery).toBeUndefined();
    expect(agent?.received).toHaveLength(0);

    await post(`/users/${ana.id}/invite`, { participants: [app.id], channel: channel.id });
    const second = await post(`/users/${ana.id}/say`, { message: { text: "@my-agent now?" }, channel: channel.id });
    await h.app.settled();
    expect(second.delivery.eventType).toBe("app_mention");
    // Joining sends `member_joined_channel`, then the message Slack posts in the channel (#58).
    expect(events(agent as RecordingAgent).map((event) => event.event.subtype ?? event.event.type)).toEqual([
      "member_joined_channel",
      "channel_join",
      "app_mention",
      "message",
    ]);
    const [joined, joinMessage] = events(agent as RecordingAgent);
    expect(joined.event).toMatchObject({ user: app.botUserId, channel: channel.id, inviter: ana.id });
    // Field for field what a real workspace sent.
    expect(joinMessage.event).toEqual({
      type: "message",
      subtype: "channel_join",
      user: app.botUserId,
      text: `<@${app.botUserId}> has joined the channel`,
      inviter: ana.id,
      ts: expect.stringMatching(/^\d{10}\.\d{6}$/),
      channel: channel.id,
      event_ts: joinMessage.event.ts,
      channel_type: "channel",
    });
  });

  test("someone joining a channel the app is in sends channel_join too, `group` in a private one", async () => {
    const { h, agent, app, user, post } = await workspace();
    const ana = await user({ name: "Ana" });
    const ben = await user({ name: "Ben" });
    const channel = await post("/channels", { private: true, participants: [ana.id, app.id] });

    await post(`/users/${ana.id}/invite`, { participants: [ben.id], channel: channel.id });
    await h.app.settled();
    expect(events(agent as RecordingAgent).map((event) => event.event)).toMatchObject([
      // A private channel's id starts with C as well, and a real workspace said "C" here.
      { type: "member_joined_channel", user: ben.id, inviter: ana.id, channel_type: "C" },
      {
        type: "message",
        subtype: "channel_join",
        user: ben.id,
        text: `<@${ben.id}> has joined the channel`,
        inviter: ana.id,
        channel_type: "group",
      },
    ]);
  });

  test("the envelope names the workspace in context_team_id, except on app_mention, as Slack's do", async () => {
    const { h, agent, app, user, post, fixture } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    await post(`/users/${ana.id}/say`, { message: { text: "@my-agent hi" }, channel: channel.id });
    await h.app.settled();
    const [mention, message] = events(agent as RecordingAgent);
    expect(mention.event.type).toBe("app_mention");
    expect(mention).not.toHaveProperty("context_team_id");
    expect(mention).not.toHaveProperty("context_enterprise_id");
    expect(message.event.type).toBe("message");
    expect(message).toMatchObject({ team_id: fixture.team.id, context_team_id: fixture.team.id });
    expect(message.context_enterprise_id).toBeNull();

    // Only on the types they were recorded with: not yet on `member_left_channel` (#88).
    const ben = await user({ name: "Ben" });
    await post(`/users/${ana.id}/invite`, { participants: [ben.id], channel: channel.id });
    await post(`/users/${ana.id}/kick`, { participant: ben.id, channel: channel.id });
    await h.app.settled();
    const byType = (type: string) => events(agent as RecordingAgent).find((event) => event.event.type === type);
    expect(byType("member_joined_channel")).toHaveProperty("context_team_id", fixture.team.id);
    expect(byType("member_left_channel")).not.toHaveProperty("context_team_id");
  });

  test("a DM to the app opens (or reuses) an im and sends message.im", async () => {
    const { h, agent, app, user, post, get } = await workspace();
    const ana = await user({ name: "Ana" });

    const message = await post(`/users/${ana.id}/say`, {
      message: { text: "what's on my plate today?" },
      to: [app.id],
    });
    const again = await post(`/users/${ana.id}/say`, { message: { text: "and tomorrow?" }, to: [app.id] });
    await h.app.settled();

    expect(message.conversation.kind).toBe("im");
    expect(message.channel).toMatch(/^D0[0-9A-Z]{9}$/);
    expect(again.channel).toBe(message.channel);
    expect((await post(`/users/${ana.id}/open-dm`, { participants: [app.id] })).id).toBe(message.channel);
    expect(events(agent as RecordingAgent).map((event) => [event.event.type, event.event.channel_type])).toEqual([
      ["message", "im"],
      ["message", "im"],
    ]);
    expect(
      (await get(`/conversations/${message.channel}/members`)).map((member: { kind: string }) => member.kind).sort(),
    ).toEqual(["app", "user"]);

    const ben = await user({ name: "Ben" });
    const group = await post(`/users/${ana.id}/open-dm`, { participants: [ben.id, app.id] });
    expect(group).toMatchObject({ kind: "mpim", id: expect.stringMatching(/^G0/) });
  });

  test("a mention in a DM with the app is a message.im only; in a group DM it is an app_mention too", async () => {
    const { h, agent, app, user, post } = await workspace();
    const ana = await user({ name: "Ana" });
    const ben = await user({ name: "Ben" });
    await post(`/users/${ana.id}/say`, { message: { text: "@my-agent hi" }, to: [app.id] });
    await h.app.settled();
    const types = () =>
      events(agent as RecordingAgent).map(({ event }) => `${event.type}/${event.channel_type ?? "-"}`);
    expect(types()).toEqual(["message/im"]);

    await post(`/users/${ana.id}/say`, { message: { text: "@my-agent and Ben" }, to: [ben.id, app.id] });
    await h.app.settled();
    expect(types().slice(1).sort()).toEqual(["app_mention/-", "message/mpim"]);
  });

  test("replies stay in the thread, and reads separate them from the channel", async () => {
    const { h, agent, app, user, post, get, base } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    const root = await post(`/users/${ana.id}/say`, { message: { text: "status?" }, channel: channel.id });

    const reply = await post(`/users/${ana.id}/reply`, {
      message: { text: "and the API?" },
      thread: { channel: root.channel, ts: root.ts },
    });
    const nested = await post(`/users/${ana.id}/reply`, {
      message: { text: "anyone?" },
      thread: { channel: reply.channel, ts: reply.ts },
    });
    await h.app.settled();

    expect(reply.threadTs).toBe(root.ts);
    expect(nested.threadTs).toBe(root.ts);
    expect((await get(`/conversations/${channel.id}/messages`)).map((m: { text: string }) => m.text)).toEqual([
      "status?",
    ]);
    expect(
      (await get(`/conversations/${channel.id}/threads/${root.ts}/replies`)).map((m: { text: string }) => m.text),
    ).toEqual(["and the API?", "anyone?"]);
    // The thread reads back its root, as it is now (after an edit), from its own `ts` or a reply's.
    expect(nested.thread).toMatchObject({ channel: channel.id, ts: root.ts });
    await post(`/users/${ana.id}/edit`, {
      message: { channel: root.channel, ts: root.ts },
      text: { text: "status of the deploy?" },
    });
    for (const ts of [root.ts, reply.ts, nested.ts]) {
      expect(await get(`/conversations/${channel.id}/threads/${ts}`)).toMatchObject({
        ts: root.ts,
        text: "status of the deploy?",
        edited: true,
        author: { id: ana.id },
      });
    }
    expect((await h.call("GET", `${base}/conversations/${channel.id}/threads/1.2`)).body.error).toBe("not_found");
    expect(events(agent as RecordingAgent)[1].event).toMatchObject({
      type: "message",
      thread_ts: root.ts,
      text: "and the API?",
    });
  });

  test("a reply also sent to the channel is a thread_broadcast, and shows among the channel's messages", async () => {
    const { h, agent, app, user, post, get } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    const root = await post(`/users/${ana.id}/say`, { message: { text: "deploy failed" }, channel: channel.id });
    const thread = { channel: root.channel, ts: root.ts };
    await post(`/users/${ana.id}/reply`, { message: { text: "looking" }, thread });
    const fix = await post(`/users/${ana.id}/reply`, { message: { text: "fixed" }, thread, alsoSendToChannel: true });
    await h.app.settled();

    expect(events(agent as RecordingAgent).at(-1)?.event).toMatchObject({
      type: "message",
      subtype: "thread_broadcast",
      text: "fixed",
      thread_ts: root.ts,
    });
    // The channel lists the root and the broadcast reply, not the plain one.
    expect(
      (await get(`/conversations/${channel.id}/messages`)).map((message: { text: string }) => message.text),
    ).toEqual(["deploy failed", "fixed"]);
    expect((await get(`/conversations/${channel.id}/threads/${root.ts}/replies`)).at(-1).ts).toBe(fix.ts);
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe(
      "Ana: deploy failed\n  Ana: looking\n  Ana: fixed (also sent to the channel)",
    );
  });

  test("edits and deletes reach the app as message_changed and message_deleted", async () => {
    const { h, agent, app, user, post, get } = await workspace();
    const ana = await user({ name: "Ana" });
    const ben = await user({ name: "Ben", admin: true });
    const channel = await post("/channels", { participants: [ana.id, ben.id, app.id] });
    const message = await post(`/users/${ana.id}/say`, { message: { text: "uptime?" }, channel: channel.id });
    const target = { channel: message.channel, ts: message.ts };

    const edited = await post(`/users/${ana.id}/edit`, { text: { text: "uptime this month?" }, message: target });
    expect(edited).toMatchObject({ ts: message.ts, text: "uptime this month?", edited: true });
    expect(await refusal(post(`/users/${ben.id}/edit`, { text: { text: "mine now" }, message: target }))).toBe(
      "cant_update_message",
    );

    await post(`/users/${ben.id}/delete`, { message: target });
    await h.app.settled();
    expect(await get(`/conversations/${channel.id}/messages`)).toEqual([]);

    const [, changed, deleted] = events(agent as RecordingAgent);
    expect(changed.event).toMatchObject({
      type: "message",
      subtype: "message_changed",
      channel: channel.id,
      message: { text: "uptime this month?", ts: message.ts, edited: { user: ana.id } },
      previous_message: { text: "uptime?" },
    });
    expect(deleted.event).toMatchObject({
      subtype: "message_deleted",
      deleted_ts: message.ts,
      previous_message: { text: "uptime this month?" },
    });
  });

  test("reactions are recorded per person and sent as reaction_added and reaction_removed", async () => {
    const { h, agent, app, user, post, get } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    const message = await post(`/users/${ana.id}/say`, { message: { text: "login is broken" }, channel: channel.id });
    const target = { channel: message.channel, ts: message.ts };

    const added = await post(`/users/${ana.id}/react`, { emoji: ":ticket:", message: target });
    // The answer is the delivery the reaction caused.
    expect(added).toMatchObject({ id: expect.stringMatching(/^Ev0/), eventType: "reaction_added", channel: "slack" });
    expect(await refusal(post(`/users/${ana.id}/react`, { emoji: "ticket", message: target }))).toBe("already_reacted");
    expect(await get(`/conversations/${channel.id}/messages/${message.ts}/reactions`)).toEqual([
      { emoji: "ticket", by: [expect.objectContaining({ id: ana.id, kind: "user" })] },
    ]);

    await post(`/users/${ana.id}/unreact`, { emoji: "ticket", message: target });
    expect(await refusal(post(`/users/${ana.id}/unreact`, { emoji: "ticket", message: target }))).toBe("no_reaction");
    await h.app.settled();
    expect(await get(`/conversations/${channel.id}/messages/${message.ts}/reactions`)).toEqual([]);
    expect(
      events(agent as RecordingAgent)
        .slice(1)
        .map((event) => event.event),
    ).toMatchObject([
      {
        type: "reaction_added",
        user: ana.id,
        reaction: "ticket",
        item: { type: "message", channel: channel.id, ts: message.ts },
        item_user: ana.id,
      },
      { type: "reaction_removed", reaction: "ticket" },
    ]);

    // Where the app isn't a member it isn't told, so there is no delivery to hand back.
    const quiet = await post("/channels", { participants: [ana.id] });
    const unheard = await post(`/users/${ana.id}/say`, { message: { text: "between us" }, channel: quiet.id });
    expect(
      await post(`/users/${ana.id}/react`, { emoji: "eyes", message: { channel: unheard.channel, ts: unheard.ts } }),
    ).toBeNull();
    // A message reads like its thread: itself, then the replies under it.
    await post(`/users/${ana.id}/reply`, { message: { text: "still broken" }, thread: target });
    expect((await get(`/conversations/${channel.id}/messages/${message.ts}/transcript`)).text).toBe(
      "Ana: login is broken\n  Ana: still broken",
    );
  });

  test("the platform refuses what Slack refuses", async () => {
    const { app, user, post } = await workspace({ agent: false });
    const ana = await user({ name: "Ana" });
    const ben = await user({ name: "Ben" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    const say = (who: { id: string }, body: unknown) => post(`/users/${who.id}/say`, body);

    expect(await refusal(say(ben, { message: { text: "hi" }, channel: channel.id }))).toBe("not_in_channel");
    expect(await refusal(say(ana, { message: {}, channel: channel.id }))).toBe("no_text");
    expect(await refusal(say(ana, { message: { text: "x".repeat(40_001) }, channel: channel.id }))).toBe(
      "msg_too_long",
    );
    expect(await refusal(say(ana, { message: { text: "hi" } }))).toBe("invalid_argument");
    expect(await refusal(say(ana, { message: { text: "hi" }, channel: channel.id, to: [ben.id] }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(say(ana, { message: { text: "hi" }, channel: "C0NOTHERE00" }))).toBe("not_found");
    expect(await refusal(post(`/users/${ana.id}/invite`, { participants: [app.id], channel: channel.id }))).toBe(
      "already_in_channel",
    );
    expect(await refusal(post(`/users/${ana.id}/kick`, { participant: ben.id, channel: channel.id }))).toBe(
      "not_in_channel",
    );
    expect(await refusal(post(`/users/${ana.id}/open-dm`, { participants: [ana.id] }))).toBe("invalid_argument");
    // A DM is between two: talking with a third is a group DM of its own.
    const dm = await post(`/users/${ana.id}/open-dm`, { participants: [ben.id] });
    expect(await refusal(post(`/users/${ana.id}/invite`, { participants: [app.id], channel: dm.id }))).toBe(
      "method_not_supported_for_channel_type",
    );
  });

  test("kicking the app tells it once, then it hears nothing more", async () => {
    const { h, agent, app, user, post } = await workspace();
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });

    await post(`/users/${ana.id}/kick`, { participant: app.id, channel: channel.id });
    await post(`/users/${ana.id}/say`, { message: { text: "@my-agent still there?" }, channel: channel.id });
    await h.app.settled();

    expect(events(agent as RecordingAgent).map((event) => event.event.type)).toEqual(["member_left_channel"]);
  });

  test("sessions don't see each other's conversations or events", async () => {
    const { h, app, user, post, sessionId } = await workspace();
    const other = await session(h);
    const ana = await user({ name: "Ana" });
    const channel = await post("/channels", { participants: [ana.id, app.id] });
    await post(`/users/${ana.id}/say`, { message: { text: "@my-agent hi" }, channel: channel.id });
    await h.app.settled();

    expect((await h.call("GET", `${other.base}/conversations/${channel.id}/messages`)).body.error).toBe("not_found");
    expect(await refusal(other.post("/channels", { participants: [ana.id] }))).toBe("not_found");
    expect((await h.call("GET", `/sessions/${other.sessionId}/events`)).body.events).toEqual([]);
    const mine = (await h.call("GET", `/sessions/${sessionId}/events`)).body.events;
    expect(mine.filter((event: { kind: string }) => event.kind === "delivery_attempt")).toHaveLength(2);
    // `@name` resolves among the session's own people: another session's Ana isn't mentioned.
    const otherBen = await other.user({ name: "Ben" });
    const room = await other.post("/channels", { participants: [otherBen.id] });
    const said = await other.post(`/users/${otherBen.id}/say`, {
      message: { text: "ping @Ana and @Ben" },
      channel: room.id,
    });
    expect(said.text).toBe(`ping @Ana and <@${otherBen.id}>`);
  });
});
