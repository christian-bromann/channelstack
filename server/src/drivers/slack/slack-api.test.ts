import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/** A workspace with Ana, a channel she shares with the app, and the Web API as the agent calls it. */
async function workspace() {
  const agent = await recordingAgent();
  agents.push(agent);
  const h = harness({ slack: agent.url });
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const post = async (path: string, body?: unknown) => (await h.call("POST", `${base}${path}`, body)).body;
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const { app, team } = await get("");
  const ana = await post("/users", { name: "Ana", email: "ana@example.com" });
  const channel = await post("/channels", { participants: [ana.id, app.id] });
  const say = (text: string, where: Record<string, unknown> = { channel: channel.id }) =>
    post(`/users/${ana.id}/say`, { message: { text }, ...where });
  /** Call a Web API method with a JSON body and the bot token, like `@slack/web-api` does. */
  const api = async (method: string, args: Record<string, unknown> = {}, token: string | null = app.botToken) =>
    (await h.provider("POST", `slack/api/${method}`, args, token)).body;
  const calls = async () =>
    (await h.call("GET", `/sessions/${sessionId}/events`)).body.events
      .filter((event: { kind: string }) => event.kind === "api_call")
      .map((event: { data: unknown }) => event.data);
  return { h, agent, sessionId, app, team, ana, channel, post, get, say, api, calls };
}

const eventTypes = (agent: RecordingAgent) =>
  agent.received.map((delivery) => JSON.parse(delivery.body).event).map((event) => event.subtype ?? event.type);

describe("authentication", () => {
  test("auth.test answers for the bot, like Slack", async () => {
    const { api, app, team } = await workspace();
    expect(await api("auth.test")).toEqual({
      ok: true,
      url: "https://acme.slack.com/",
      team: "Acme",
      user: "my-agent",
      team_id: team.id,
      user_id: app.botUserId,
      bot_id: app.botId,
      is_enterprise_install: false,
    });
  });

  test("a missing or wrong token is refused with Slack's codes, and so is an unknown method", async () => {
    const { api } = await workspace();
    expect(await api("auth.test", {}, null)).toEqual({ ok: false, error: "not_authed" });
    expect(await api("auth.test", {}, "xoxb-not-the-token")).toEqual({ ok: false, error: "invalid_auth" });
    expect(await api("chat.frobnicate")).toEqual({ ok: false, error: "unknown_method", req_method: "chat.frobnicate" });
  });

  test("the token and arguments are also accepted as a form body", async () => {
    const { h, app, channel } = await workspace();
    const response = await h.app.fetch(
      new Request("http://127.0.0.1:4500/slack/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: app.botToken, channel: channel.id, text: "from a form", blocks: "[]" }),
      }),
    );
    expect(response.headers.get("x-oauth-scopes")).toContain("chat:write");
    expect(await response.json()).toMatchObject({ ok: true, channel: channel.id, message: { text: "from a form" } });
  });
});

describe("chat", () => {
  test("the app posts in a channel and in a thread, and people read it back", async () => {
    const { api, app, channel, say, get } = await workspace();
    const question = await say("@my-agent status?");

    const top = await api("chat.postMessage", { channel: channel.id, text: "Looking into it" });
    const reply = await api("chat.postMessage", { channel: channel.id, thread_ts: question.ts, text: "All green" });

    expect(top).toMatchObject({
      ok: true,
      channel: channel.id,
      message: { type: "message", user: app.botUserId, bot_id: app.botId, app_id: app.id, text: "Looking into it" },
    });
    expect(top.ts).toMatch(/^\d{10}\.\d{6}$/);
    expect(reply.message.thread_ts).toBe(question.ts);
    // What real Slack adds to a message the app posts (#30): its bot's profile, a rich_text block of
    // its text, and in a thread, who wrote the message the thread starts with.
    expect(top.message.bot_profile).toMatchObject({
      id: app.botId,
      app_id: app.id,
      user_id: app.botUserId,
      name: "my-agent",
      deleted: false,
    });
    expect(top.message.bot_profile.updated).toEqual(expect.any(Number));
    expect(top.message.blocks).toEqual([
      {
        type: "rich_text",
        block_id: expect.any(String),
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Looking into it" }] }],
      },
    ]);
    expect(top.message).not.toHaveProperty("parent_user_id");
    expect(reply.message.parent_user_id).toBe(question.author.id);
    expect((await get(`/conversations/${channel.id}/messages`)).map((m: { text: string }) => m.text)).toEqual([
      question.text,
      "Looking into it",
    ]);
    const [answer] = await get(`/conversations/${channel.id}/threads/${question.ts}/replies`);
    expect(answer).toMatchObject({
      text: "All green",
      author: { kind: "app", id: app.id, name: "my-agent" },
      threadTs: question.ts,
    });
    // A message the app posts with blocks keeps its own.
    const withBlocks = await api("chat.postMessage", {
      channel: channel.id,
      text: "fallback",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Deploy*" } }],
    });
    expect(withBlocks.message.blocks.map((block: { type: string }) => block.type)).toEqual(["section"]);
  });

  test("posting to a user id opens the DM with that person", async () => {
    const { api, ana, get } = await workspace();
    const sent = await api("chat.postMessage", { channel: ana.id, text: "hello Ana" });
    expect(sent.channel).toMatch(/^D0/);
    expect((await get(`/conversations/${sent.channel}/messages`))[0]).toMatchObject({
      text: "hello Ana",
      conversation: { kind: "im" },
    });
  });

  test("Slack's refusals: not a member, unknown or private channel, no text, too long, unknown thread", async () => {
    const { api, ana, channel, post } = await workspace();
    const open = await post("/channels", { participants: [ana.id] });
    const secret = await post("/channels", { participants: [ana.id], private: true });
    const error = async (args: Record<string, unknown>) => (await api("chat.postMessage", args)).error;

    expect(await error({ channel: open.id, text: "hi" })).toBe("not_in_channel");
    expect(await error({ channel: secret.id, text: "hi" })).toBe("channel_not_found");
    expect(await error({ channel: "C0NOTHERE00", text: "hi" })).toBe("channel_not_found");
    expect(await error({ channel: channel.id })).toBe("no_text");
    expect(await error({ channel: channel.id, text: "x".repeat(40_001) })).toBe("msg_too_long");
    expect(await error({ channel: channel.id, text: "hi", thread_ts: "1700000000.000001" })).toBe("thread_not_found");
    expect(await error({ text: "hi" })).toBe("invalid_arguments");
  });

  test("the app can update and delete its own messages only", async () => {
    const { h, agent, api, channel, say, get } = await workspace();
    const theirs = await say("mine");
    const own = await api("chat.postMessage", { channel: channel.id, text: "Thinking…" });

    expect(await api("chat.update", { channel: channel.id, ts: own.ts, text: "Done" })).toMatchObject({
      ok: true,
      text: "Done",
      message: { edited: {} },
    });
    expect((await api("chat.update", { channel: channel.id, ts: theirs.ts, text: "hijack" })).error).toBe(
      "cant_update_message",
    );
    expect((await api("chat.delete", { channel: channel.id, ts: theirs.ts })).error).toBe("cant_delete_message");
    expect((await api("chat.update", { channel: channel.id, ts: "1700000000.000001", text: "x" })).error).toBe(
      "message_not_found",
    );
    expect(await api("chat.delete", { channel: channel.id, ts: own.ts })).toEqual({
      ok: true,
      channel: channel.id,
      ts: own.ts,
    });
    await h.app.settled();

    expect((await get(`/conversations/${channel.id}/messages`)).map((m: { text: string }) => m.text)).toEqual(["mine"]);
    // The app hears about its own messages too, as on Slack: agents have to ignore themselves.
    expect(eventTypes(agent)).toEqual(["message", "message", "message_changed", "message_deleted"]);
  });

  test("an ephemeral message is only for its recipient and sends no event", async () => {
    const { h, agent, api, ana, channel, get } = await workspace();
    const sent = await api("chat.postEphemeral", {
      channel: channel.id,
      user: ana.id,
      text: "Only you can approve this",
    });
    await h.app.settled();

    expect(sent).toEqual({ ok: true, message_ts: expect.stringMatching(/^\d{10}\.\d{6}$/) });
    expect((await api("chat.postEphemeral", { channel: channel.id, user: "U0NOBODY000", text: "x" })).error).toBe(
      "user_not_in_channel",
    );
    // It isn't part of the conversation: not among its messages, not its newest message, not in history.
    expect(await get(`/conversations/${channel.id}/messages`)).toEqual([]);
    expect((await get(`/conversations/${channel.id}/latest`)).error).toBe("not_found");
    expect((await api("conversations.history", { channel: channel.id })).messages).toEqual([]);
    expect(agent.received).toHaveLength(0);
    // Only its recipient reads it: in their ephemeral messages, and in a transcript read as them.
    const [message] = await get(`/users/${ana.id}/ephemeral`);
    expect(message).toMatchObject({ text: "Only you can approve this", visibleTo: { id: ana.id } });
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe("");
    expect((await get(`/conversations/${channel.id}/transcript?as=${ana.id}`)).text).toBe(
      "my-agent: Only you can approve this (only Ana sees this)",
    );
    // Slack doesn't keep it, so the app can't edit it, delete it or react to it.
    const target = { channel: channel.id, ts: sent.message_ts };
    expect((await api("chat.update", { ...target, text: "changed" })).error).toBe("message_not_found");
    expect((await api("chat.delete", target)).error).toBe("message_not_found");
    expect((await api("reactions.add", { channel: channel.id, timestamp: sent.message_ts, name: "eyes" })).error).toBe(
      "message_not_found",
    );
  });

  test("an ephemeral reply in a thread is not one of the thread's replies", async () => {
    const { api, ana, channel, say, get } = await workspace();
    const question = await say("@my-agent may I approve?");
    await api("chat.postEphemeral", { channel: channel.id, user: ana.id, thread_ts: question.ts, text: "You may not" });
    expect(await get(`/conversations/${channel.id}/threads/${question.ts}/replies`)).toEqual([]);
    expect((await api("conversations.replies", { channel: channel.id, ts: question.ts })).messages).toHaveLength(1);
  });

  test("history and replies honour oldest, latest, inclusive and limit; a cursor is refused", async () => {
    const { api, channel, say } = await workspace();
    const [first, second, third] = [await say("one"), await say("two"), await say("three")];
    const history = (args: Record<string, unknown>) => api("conversations.history", { channel: channel.id, ...args });
    const texts = (response: { messages: Array<{ text: string }> }) => response.messages.map(({ text }) => text);

    // Slack's way to fetch one message by its ts.
    const one = await history({ latest: first.ts, inclusive: true, limit: 1 });
    expect([texts(one), one.has_more]).toEqual([["one"], false]);
    expect(texts(await history({ oldest: first.ts }))).toEqual(["three", "two"]);
    expect(texts(await history({ oldest: first.ts, latest: third.ts }))).toEqual(["two"]);
    const limited = await history({ limit: 2 });
    expect([texts(limited), limited.has_more]).toEqual([["three", "two"], true]);
    expect((await history({ cursor: "bmV4dA==" })).error).toBe("invalid_cursor");

    await api("chat.postMessage", { channel: channel.id, thread_ts: second.ts, text: "a" });
    const late = await api("chat.postMessage", { channel: channel.id, thread_ts: second.ts, text: "b" });
    const replies = await api("conversations.replies", {
      channel: channel.id,
      ts: second.ts,
      oldest: late.ts,
      inclusive: true,
    });
    expect(texts(replies)).toEqual(["two", "b"]);
  });

  test("a mention of someone nobody knows doesn't break the transcript", async () => {
    const { api, channel, get } = await workspace();
    await api("chat.postMessage", { channel: channel.id, text: "Thanks <@U0HALLUCIN8> and <@U0LABELLED0|sam>!" });
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe("my-agent: Thanks @U0HALLUCIN8 and @sam!");
  });
});

describe("streams and status", () => {
  test("a stream grows one message and ends completed", async () => {
    const { api, ana, team, channel, say, get } = await workspace();
    const question = await say("@my-agent write the release notes");
    const recipient = { recipient_user_id: ana.id, recipient_team_id: team.id };

    const started = await api("chat.startStream", { channel: channel.id, thread_ts: question.ts, ...recipient });
    expect(started).toEqual({ ok: true, channel: channel.id, ts: expect.any(String) });
    await api("chat.appendStream", { channel: channel.id, ts: started.ts, markdown_text: "## 0.10\n" });
    await api("chat.appendStream", {
      channel: channel.id,
      ts: started.ts,
      chunks: [
        { type: "markdown_text", text: "- streams" },
        { type: "task_update", id: "t1", title: "x", status: "complete" },
      ],
    });
    const feedback = {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Helpful" } }],
    };
    const stopped = await api("chat.stopStream", {
      channel: channel.id,
      ts: started.ts,
      markdown_text: "\n- status",
      blocks: [feedback],
    });

    expect(stopped).toMatchObject({ ok: true, ts: started.ts, message: { text: "## 0.10\n- streams\n- status" } });
    // Blocks added at the end get their ids like any others, so their controls can be found and pressed.
    expect(stopped.message.blocks.at(-1)).toMatchObject({
      block_id: expect.any(String),
      elements: [{ action_id: expect.any(String) }],
    });
    const replies = await get(`/conversations/${channel.id}/threads/${question.ts}/replies`);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("## 0.10\n- streams\n- status");
    expect((await api("chat.appendStream", { channel: channel.id, ts: started.ts, markdown_text: "late" })).error).toBe(
      "message_not_in_streaming_state",
    );
    expect((await api("chat.stopStream", { channel: channel.id, ts: started.ts })).error).toBe(
      "message_not_in_streaming_state",
    );
  });

  test("Slack's stream rules: where a top-level stream is allowed, recipients, limits", async () => {
    const { api, ana, team, channel, say } = await workspace();
    const question = await say("go");
    const recipient = { recipient_user_id: ana.id, recipient_team_id: team.id };
    const start = async (args: Record<string, unknown>) => api("chat.startStream", args);

    expect((await start({ channel: channel.id, ...recipient })).error).toBe("invalid_thread_ts");
    expect((await start({ channel: channel.id, thread_ts: question.ts })).error).toBe("invalid_arguments");
    expect(
      (await start({ channel: channel.id, thread_ts: question.ts, ...recipient, markdown_text: "a", chunks: [] }))
        .error,
    ).toBe("cannot_provide_both_markdown_text_and_chunks");
    // In a DM the whole conversation is the session, so a top-level stream works and needs no recipient.
    const dm = await start({ channel: ana.id, markdown_text: "x".repeat(11_990) });
    expect(dm.ok).toBe(true);
    expect(
      (await api("chat.appendStream", { channel: dm.channel, ts: dm.ts, markdown_text: "y".repeat(11) })).error,
    ).toBe("msg_too_long");
    expect((await api("chat.appendStream", { channel: dm.channel, ts: dm.ts, markdown_text: "y".repeat(10) })).ok).toBe(
      true,
    );
  });

  test("the status line is cleared by the app's reply; the session status is separate", async () => {
    const { h, api, channel, say } = await workspace();
    const question = await say("@my-agent think");
    const thread = { channel_id: channel.id, thread_ts: question.ts };

    expect(await api("assistant.threads.setStatus", { ...thread, status: "is thinking…" })).toEqual({ ok: true });
    expect(await api("agents.sessions.setStatus", { ...thread, status: "processing" })).toEqual({
      ok: true,
      status: "processing",
      agent_status: "processing",
    });
    expect((await api("agents.sessions.setStatus", { ...thread, status: "working" })).error).toBe("invalid_arguments");
    expect((await api("assistant.threads.setStatus", { channel_id: channel.id, thread_ts: question.ts })).error).toBe(
      "invalid_arguments",
    );
    // A title and suggested prompts are accepted under both the assistant and the agent-session names.
    expect(await api("assistant.threads.setTitle", { ...thread, title: "Thinking it over" })).toEqual({ ok: true });
    expect(await api("agents.sessions.rename", { ...thread, title: "Thought it over" })).toEqual({ ok: true });
    expect((await api("agents.sessions.rename", thread)).error).toBe("invalid_arguments");
    const prompts = [{ title: "Summarize", message: "Summarize this channel" }];
    expect(await api("assistant.threads.setSuggestedPrompts", { ...thread, prompts })).toEqual({ ok: true });
    expect((await api("assistant.threads.setSuggestedPrompts", { ...thread, prompts: [] })).error).toBe(
      "invalid_arguments",
    );
    await api("chat.postMessage", { channel: channel.id, thread_ts: question.ts, text: "done" });
    // Reads of the status come with the transcript routes; here it is enough that every call was accepted.
    expect((await h.call("GET", "/status")).status).toBe(200);
  });
});

describe("reactions, conversations and users", () => {
  test("the app reacts once per emoji, and reads reactions back", async () => {
    const { api, app, channel, say, get } = await workspace();
    const message = await say("@my-agent look at the build");
    const target = { channel: channel.id, timestamp: message.ts };

    expect(await api("reactions.add", { ...target, name: "eyes" })).toEqual({ ok: true });
    expect((await api("reactions.add", { ...target, name: ":eyes:" })).error).toBe("already_reacted");
    expect((await api("reactions.get", target)).message.reactions).toEqual([
      { name: "eyes", users: [app.botUserId], count: 1 },
    ]);
    expect(await get(`/conversations/${channel.id}/messages/${message.ts}/reactions`)).toEqual([
      { emoji: "eyes", by: [expect.objectContaining({ kind: "app", id: app.id })] },
    ]);
    expect(await api("reactions.remove", { ...target, name: "eyes" })).toEqual({ ok: true });
    expect((await api("reactions.remove", { ...target, name: "eyes" })).error).toBe("no_reaction");
  });

  test("history is newest first, replies oldest first with the root", async () => {
    const { h, agent, api, app, channel, say, post, get, ana } = await workspace();
    const first = await say("one");
    await say("two");
    await post(`/users/${ana.id}/reply`, { message: { text: "one-a" }, thread: { channel: channel.id, ts: first.ts } });

    expect(
      (await api("conversations.history", { channel: channel.id })).messages.map((m: { text: string }) => m.text),
    ).toEqual(["two", "one"]);
    expect(
      (await api("conversations.replies", { channel: channel.id, ts: first.ts })).messages.map(
        (m: { text: string }) => m.text,
      ),
    ).toEqual(["one", "one-a"]);
    expect((await api("conversations.members", { channel: channel.id })).members).toHaveLength(2);

    // A reply says who wrote the message its thread starts with, wherever it is read (#30); the
    // app's own messages carry their bot's profile, and the rich_text block of their text.
    const answer = await api("chat.postMessage", { channel: channel.id, thread_ts: first.ts, text: "on it" });
    await h.app.settled();
    const replies = (await api("conversations.replies", { channel: channel.id, ts: first.ts })).messages;
    expect(replies.map((m: { parent_user_id?: string }) => m.parent_user_id)).toEqual([undefined, ana.id, ana.id]);
    expect(replies.at(-1)).toMatchObject({
      bot_id: app.botId,
      bot_profile: { id: app.botId, team_id: expect.any(String) },
    });
    const delivered = agent.received.map((delivery) => JSON.parse(delivery.body).event);
    expect(delivered.find((event: { text?: string }) => event.text === "one-a")).toMatchObject({
      parent_user_id: ana.id,
    });
    const history = (await api("conversations.history", { channel: channel.id })).messages;
    expect(history.every((m: { parent_user_id?: string }) => m.parent_user_id === undefined)).toBe(true);
    // What a test reads of the app's message through the control API: the same block.
    const read = await get(`/conversations/${channel.id}/messages/${answer.ts}`);
    expect(read.blocks).toEqual([
      {
        type: "rich_text",
        block_id: expect.any(String),
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "on it" }] }],
      },
    ]);
  });

  test("conversations.info, join, open and list follow Slack's visibility rules", async () => {
    const { h, agent, api, ana, app, channel, post } = await workspace();
    const open = await post("/channels", { name: "general", participants: [ana.id] });
    const secret = await post("/channels", { participants: [ana.id], private: true });

    expect((await api("conversations.info", { channel: channel.id })).channel).toMatchObject({
      id: channel.id,
      is_channel: true,
      is_private: false,
      is_member: true,
      num_members: 2,
      // What real Slack says of a channel of one workspace (#30).
      is_shared: false,
      is_ext_shared: false,
      is_org_shared: false,
      is_pending_ext_shared: false,
      is_general: false,
      name_normalized: channel.name,
      previous_names: [],
      parent_conversation: null,
      unlinked: 0,
      last_read: "0000000000.000000",
      pending_shared: [],
      pending_connected_team_ids: [],
      properties: {},
    });
    const info = (await api("conversations.info", { channel: channel.id })).channel;
    expect(info.context_team_id).toMatch(/^T/);
    expect(info.shared_team_ids).toEqual([info.context_team_id]);
    // `updated` is in milliseconds, `created` in seconds.
    expect(info.updated).toBe(info.created * 1000);
    // Only conversations.info says what the app last read.
    const [listed] = (await api("conversations.list")).channels;
    expect(listed).toMatchObject({ is_shared: false, name_normalized: listed.name });
    expect(listed).not.toHaveProperty("last_read");
    expect((await api("conversations.info", { channel: open.id })).error).toBe("not_in_channel");
    expect((await api("conversations.list")).channels.map((c: { id: string }) => c.id)).toEqual([channel.id, open.id]);
    expect((await api("conversations.list", { types: "public_channel,private_channel" })).channels).toHaveLength(2);

    expect((await api("conversations.join", { channel: secret.id })).error).toBe("channel_not_found");
    expect((await api("conversations.join", { channel: open.id })).channel).toMatchObject({
      name: "general",
      is_member: true,
    });
    expect((await api("conversations.join", { channel: open.id })).warning).toBe("already_in_channel");
    await h.app.settled();
    // Joining on its own: no inviter, on either event (#58).
    expect(eventTypes(agent)).toEqual(["member_joined_channel", "channel_join"]);
    const [joinedEvent, joinMessage] = agent.received.map((delivery) => JSON.parse(delivery.body).event);
    expect(joinedEvent).not.toHaveProperty("inviter");
    expect(joinMessage).toEqual({
      type: "message",
      subtype: "channel_join",
      user: app.botUserId,
      text: `<@${app.botUserId}> has joined the channel`,
      ts: joinMessage.ts,
      channel: open.id,
      event_ts: joinMessage.ts,
      channel_type: "channel",
    });

    const dm = await api("conversations.open", { users: ana.id });
    expect((await api("conversations.info", { channel: dm.channel.id })).channel).toMatchObject({
      is_im: true,
      user: ana.id,
    });
    expect((await api("conversations.open", { users: "U0NOBODY000" })).error).toBe("user_not_found");
    expect(app.botUserId).toMatch(/^U0/);
  });

  test("users.info and users.list describe people the way Slack does", async () => {
    const { api, ana, app } = await workspace();
    expect((await api("users.info", { user: ana.id })).user).toMatchObject({
      id: ana.id,
      name: "ana",
      real_name: "Ana",
      is_bot: false,
      is_admin: false,
      profile: { display_name: "Ana", email: "ana@example.com" },
    });
    expect((await api("users.info", { user: app.botUserId })).user).toMatchObject({
      is_bot: true,
      profile: { api_app_id: app.id },
    });
    expect((await api("users.info", { user: "U0NOBODY000" })).error).toBe("user_not_found");
    expect((await api("users.list")).members.map((member: { id: string }) => member.id)).toEqual([
      app.botUserId,
      ana.id,
    ]);
  });
});

describe("what the agent did is recorded", () => {
  test("calls about a conversation land in its session's event log, without the token", async () => {
    const { api, app, channel, calls, h } = await workspace();
    await api("auth.test");
    await api("chat.postMessage", { channel: channel.id, text: "hi" });
    await api("chat.postMessage", { channel: channel.id });

    const recorded = await calls();
    expect(recorded).toMatchObject([
      {
        operation: "chat.postMessage",
        method: "POST",
        path: "/slack/api/chat.postMessage",
        request: { channel: channel.id, text: "hi" },
        responseStatus: 200,
        response: { ok: true },
      },
      { operation: "chat.postMessage", error: "no_text", response: { ok: false, error: "no_text" } },
    ]);
    expect(JSON.stringify(recorded)).not.toContain(app.botToken);
    expect(JSON.stringify(recorded)).not.toContain(h.secrets.get("slack", "botToken"));
  });
});

describe("reply_broadcast", () => {
  test("the app's thread reply with reply_broadcast also shows in the channel; outside a thread it means nothing", async () => {
    const { channel, say, api, get } = await workspace();
    const question = await say("@my-agent status?");
    const reply = await api("chat.postMessage", {
      channel: channel.id,
      thread_ts: question.ts,
      text: "all green",
      reply_broadcast: true,
    });
    expect(reply.message).toMatchObject({ subtype: "thread_broadcast", thread_ts: question.ts });
    const plain = await api("chat.postMessage", { channel: channel.id, text: "fyi", reply_broadcast: true });
    expect(plain.message.subtype).toBeUndefined();
    const texts = (await get(`/conversations/${channel.id}/messages`)).map((message: { text: string }) => message.text);
    expect(texts.slice(1)).toEqual(["all green", "fyi"]);
  });
});

describe("calls that name no channel", () => {
  test("a call about a person, or a file shared in a conversation, lands in that session; auth.test in none", async () => {
    const { h, ana, channel, api, calls, say } = await workspace();
    await api("auth.test");
    await api("users.info", { user: ana.id });
    await api("users.info", { user: "U0NOBODY000" });
    await api("conversations.open", { users: ana.id });

    const ticket = await api("files.getUploadURLExternal", { filename: "a.txt", length: 2 });
    await h.app.fetch(
      new Request(ticket.upload_url, {
        method: "POST",
        headers: { authorization: `Bearer ${h.secrets.get("slack", "botToken")}` },
        body: "hi",
      }),
    );
    await say("share it");
    await api("files.completeUploadExternal", { files: [{ id: ticket.file_id }], channel_id: channel.id });
    await api("files.info", { file: ticket.file_id });

    expect((await calls()).map((call: { operation: string }) => call.operation)).toEqual([
      "users.info",
      "conversations.open",
      "files.completeUploadExternal",
      "files.info",
    ]);
  });
});

describe("files (upload v2, the basics)", () => {
  test("the app uploads a file in three steps and it lands in the thread", async () => {
    const { h, agent, app, channel, say, api, get } = await workspace();
    const question = await say("@my-agent export the report");
    await h.app.settled();
    const content = "quarter,revenue\nQ3,42\n";

    const ticket = await api("files.getUploadURLExternal", { filename: "report.csv", length: content.length });
    expect(ticket).toMatchObject({ ok: true, file_id: expect.stringMatching(/^F0[0-9A-Z]{9}$/) });
    // The upload URL is on the fake, and takes the bytes with the bot token like Slack's does.
    const path = new URL(ticket.upload_url).pathname.replace(/^\//, "");
    expect(path).toBe(`slack/upload/v1/${ticket.file_id}`);

    // Sharing a file that has no bytes yet is refused.
    const share = {
      files: [{ id: ticket.file_id, title: "Q3 report" }],
      channel_id: channel.id,
      thread_ts: question.ts,
    };
    expect((await api("files.completeUploadExternal", share)).error).toBe("file_not_found");

    const uploaded = await h.app.fetch(
      new Request(`http://127.0.0.1:4500/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.botToken}` },
        body: content,
      }),
    );
    expect([uploaded.status, await uploaded.text()]).toEqual([200, `OK - ${content.length}`]);

    const done = await api("files.completeUploadExternal", { ...share, initial_comment: "Here it is." });
    expect(done).toMatchObject({ ok: true, files: [{ id: ticket.file_id, title: "Q3 report" }] });
    await h.app.settled();

    // The app's own message comes back as a file share, with the file on it.
    const event = JSON.parse(agent.received.at(-1)?.body ?? "{}").event;
    expect(event).toMatchObject({
      type: "message",
      subtype: "file_share",
      text: "Here it is.",
      thread_ts: question.ts,
      files: [{ id: ticket.file_id, name: "report.csv", title: "Q3 report", filetype: "csv", size: content.length }],
    });
    expect((await api("files.info", { file: ticket.file_id })).file).toMatchObject({
      name: "report.csv",
      mimetype: "text/csv",
    });
    // A person reads it as the comment with the file's name.
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe(
      "Ana: @my-agent export the report\n  my-agent: Here it is. [file: report.csv]",
    );
  });

  test("what Slack refuses", async () => {
    const { api, channel } = await workspace();
    expect((await api("files.getUploadURLExternal", { filename: "a.txt" })).error).toBe("invalid_arguments");
    expect((await api("files.getUploadURLExternal", { filename: "a.txt", length: 0 })).error).toBe("invalid_arguments");
    expect((await api("files.info", { file: "F0NOSUCHFIL" })).error).toBe("file_not_found");
    expect(
      (await api("files.completeUploadExternal", { files: [{ id: "F0NOSUCHFIL" }], channel_id: channel.id })).error,
    ).toBe("file_not_found");
    expect((await api("files.completeUploadExternal", { files: [] })).error).toBe("invalid_arguments");
  });
});

describe("files a person shares", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  test("a person's message shares files the agent reads from url_private with its bot token", async () => {
    const { h, agent, app, ana, channel, post, api, get } = await workspace();
    const log = "Error: disk full\n";
    const said = await post(`/users/${ana.id}/say`, {
      message: { text: "@my-agent why does it crash?" },
      channel: channel.id,
      files: [{ path: "crash.log", content: b64(log) }],
    });
    await h.app.settled();

    // Slack sends the mention, and the message as a file share, both with the file on them.
    const events = agent.received.map((delivery) => JSON.parse(delivery.body).event);
    const file = { name: "crash.log", user: ana.id, size: log.length, mimetype: "application/octet-stream" };
    expect(events.find((event) => event.type === "app_mention")).toMatchObject({ files: [file] });
    const shared = events.find((event) => event.type === "message");
    expect(shared).toMatchObject({ subtype: "file_share", user: ana.id, files: [file] });
    const [{ id, url_private, url_private_download }] = shared.files;
    expect(id).toMatch(/^F0[0-9A-Z]{9}$/);
    expect((await api("files.info", { file: id })).file).toMatchObject({ ...file, url_private });

    const download = async (url: string, token: string | undefined) =>
      h.app.fetch(new Request(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }));
    const read = await download(url_private, app.botToken);
    expect([read.status, await read.text()]).toEqual([200, log]);
    const attachment = await download(url_private_download, app.botToken);
    expect(attachment.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''crash.log");
    expect(await attachment.text()).toBe(log);
    // Only the bot token reads it.
    expect((await download(url_private, undefined)).status).toBe(403);
    expect((await download(url_private, app.appToken)).status).toBe(403);

    // A reply shares files too, with no text, and a person reads the names in the transcript.
    await post(`/users/${ana.id}/reply`, {
      message: {},
      thread: { channel: channel.id, ts: said.ts },
      files: [{ path: "a.png", content: b64("png") }],
    });
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe(
      "Ana: @my-agent why does it crash? [file: crash.log]\n  Ana: [file: a.png]",
    );
  });

  test("the bot reads no file shared where it is no longer a member", async () => {
    const { h, agent, app, ana, channel, post } = await workspace();
    await post(`/users/${ana.id}/say`, {
      message: {},
      channel: channel.id,
      files: [{ path: "secret.txt", content: b64("between us") }],
    });
    await h.app.settled();
    const url = JSON.parse(agent.received.at(-1)?.body ?? "{}").event.files[0].url_private;
    const read = () => h.app.fetch(new Request(url, { headers: { authorization: `Bearer ${app.botToken}` } }));
    expect((await read()).status).toBe(200);
    await post(`/users/${ana.id}/kick`, { participant: app.id, channel: channel.id });
    expect((await read()).status).toBe(404);
  });

  test("what the control API refuses: a message with neither text nor files, a file over the fake's limit", async () => {
    const { ana, channel, post } = await workspace();
    expect(await post(`/users/${ana.id}/say`, { message: {}, channel: channel.id })).toMatchObject({
      error: "no_text",
    });
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    expect(
      await post(`/users/${ana.id}/say`, {
        message: {},
        channel: channel.id,
        files: [{ path: "big.bin", content: big }],
      }),
    ).toMatchObject({ error: "invalid_argument" });
  });
});
