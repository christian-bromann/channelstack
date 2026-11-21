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
    const [message] = await get(`/conversations/${channel.id}/messages`);
    expect(message).toMatchObject({ text: "Only you can approve this", visibleTo: { id: ana.id } });
    expect((await api("conversations.history", { channel: channel.id })).messages).toEqual([]);
    expect(agent.received).toHaveLength(0);
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
    const stopped = await api("chat.stopStream", { channel: channel.id, ts: started.ts, markdown_text: "\n- status" });

    expect(stopped).toMatchObject({ ok: true, ts: started.ts, message: { text: "## 0.10\n- streams\n- status" } });
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
    const { api, channel, say, post, ana } = await workspace();
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
    });
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
    expect(eventTypes(agent)).toEqual(["member_joined_channel"]);

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
