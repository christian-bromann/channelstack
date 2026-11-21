import { createHmac } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { type Harness, harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

async function open(h: Harness) {
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const post = async (path: string, body?: unknown) => (await h.call("POST", `${base}${path}`, body)).body;
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const { app, team } = await get("");
  const ana = await post("/users", { name: "Ana" });
  const channel = await post("/channels", { participants: [ana.id, app.id] });
  const say = (text: string) => post(`/users/${ana.id}/say`, { message: { text }, channel: channel.id });
  const api = async (method: string, args: Record<string, unknown> = {}) => {
    const response = await h.app.fetch(
      new Request(`http://127.0.0.1:4500/slack/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.botToken}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    );
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: (await response.json()) as any,
    };
  };
  return { sessionId, base, post, get, app, team, ana, channel, say, api };
}

async function workspace() {
  const agent = await recordingAgent();
  agents.push(agent);
  const h = harness({ slack: agent.url });
  return { h, agent, ...(await open(h)) };
}

/** An agent that verifies Slack's signature and timestamp, like Bolt does, and answers 401 when they are wrong. */
function verifying(agent: RecordingAgent, signingSecret: string) {
  agent.respond = ({ headers, body }) => {
    const timestamp = String(headers["x-slack-request-timestamp"]);
    const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
    return headers["x-slack-signature"] === expected && fresh
      ? { status: 200, body: "" }
      : { status: 401, body: "bad signature" };
  };
}

describe("deliveries", () => {
  test("a delivery records every attempt, and a retry carries Slack's retry headers", async () => {
    const { h, agent, say, get, post } = await workspace();
    const message = await say("@my-agent hi");
    await h.app.settled();

    const [mention, plain] = await get("/deliveries");
    expect(mention).toMatchObject({
      id: message.delivery.id,
      channel: "slack",
      type: "event_callback",
      eventType: "app_mention",
      eventId: message.delivery.id,
      status: "acknowledged",
      payload: { type: "event_callback", event: { type: "app_mention" } },
      attempts: [{ number: 1, transport: "http", status: "acknowledged", responseStatus: 200, forgedSignature: false }],
    });
    expect(plain.eventType).toBe("message");

    const retried = await post(`/deliveries/${mention.id}/retry`, { after: 0, reason: "http_timeout" });
    expect(retried).toMatchObject({ number: 2, status: "acknowledged" });
    const again = await post(`/deliveries/${mention.id}/retry`, { after: 0, reason: "http_error" });
    expect(again.number).toBe(3);

    const [, , second, third] = agent.received;
    expect([second?.headers["x-slack-retry-num"], second?.headers["x-slack-retry-reason"]]).toEqual([
      "1",
      "http_timeout",
    ]);
    expect([third?.headers["x-slack-retry-num"], third?.headers["x-slack-retry-reason"]]).toEqual(["2", "http_error"]);
    // A retry is the same event: same body, same event_id.
    expect(second?.body).toBe(agent.received[0]?.body);
    expect((await get(`/deliveries/${mention.id}`)).attempts).toHaveLength(3);
    expect((await get("/deliveries/Ev0NOTHERE00")).error).toBe("not_found");
  });

  test("a forged delivery is rejected by an agent that verifies: wrong secret, or a stale timestamp", async () => {
    const { h, agent, app, say, get, post } = await workspace();
    verifying(agent, app.signingSecret);
    const message = await say("@my-agent hi");
    await h.app.settled();

    const bad = await post(`/deliveries/${message.delivery.id}/resend`, { badSignature: true });
    const stale = await post(`/deliveries/${message.delivery.id}/resend`, { stale: true });
    const honest = await post(`/deliveries/${message.delivery.id}/resend`, {});

    expect(bad).toMatchObject({ status: "failed", responseStatus: 401, forgedSignature: true });
    expect(stale).toMatchObject({ status: "failed", responseStatus: 401, forgedSignature: true });
    expect(honest).toMatchObject({ status: "acknowledged", forgedSignature: false });
    const age = Date.now() / 1000 - Number(stale.requestHeaders["x-slack-request-timestamp"]);
    expect(age).toBeGreaterThan(300);
    expect((await get(`/deliveries/${message.delivery.id}`)).status).toBe("acknowledged");
  });

  test("an agent that answers after the 3 second window is recorded as timed out", async () => {
    const { h, agent, say, get } = await workspace();
    agent.respond = () => ({ status: 200, delayMs: 3300 });
    const message = await say("@my-agent slow");
    expect((await get(`/deliveries/${message.delivery.id}`)).status).toBe("pending");
    await h.app.settled();
    expect((await get(`/deliveries/${message.delivery.id}`)).attempts[0]).toMatchObject({ status: "timed_out" });
  }, 10_000);
});

describe("faults and uninstall (decision 0006: undone when the session closes)", () => {
  test("a rate limit answers 429 with Retry-After for the next calls, then the method works again", async () => {
    const { api, channel, post, get } = await workspace();
    const fault = await post("/faults", {
      type: "rate_limit",
      operation: "chat.postMessage",
      retryAfter: 1500,
      times: 1,
    });
    expect(fault.id).toEqual(expect.any(String));

    const limited = await api("chat.postMessage", { channel: channel.id, text: "hi" });
    expect(limited).toEqual({ status: 429, retryAfter: "2", body: { ok: false, error: "ratelimited" } });
    expect((await api("auth.test")).status).toBe(200);
    expect((await api("chat.postMessage", { channel: channel.id, text: "hi" })).body.ok).toBe(true);

    expect(await get("/calls?operation=chat.postMessage")).toMatchObject([
      {
        operation: "chat.postMessage",
        responseStatus: 429,
        error: "ratelimited",
        channel: "slack",
        id: expect.stringMatching(/^call_\d+$/),
      },
      { operation: "chat.postMessage", responseStatus: 200 },
    ]);
    expect(await get("/calls?error=true")).toHaveLength(1);
    expect(await get("/calls?error=not_in_channel")).toEqual([]);
  });

  test("an error fault, a latency fault, and removing a fault", async () => {
    const { h, api, base, channel, post } = await workspace();
    const broken = await post("/faults", { type: "error", operation: "reactions.add", error: "fatal_error" });
    expect((await api("reactions.add", { channel: channel.id, timestamp: "1.1", name: "eyes" })).body).toEqual({
      ok: false,
      error: "fatal_error",
    });
    expect((await h.call("DELETE", `${base}/faults/${broken.id}`)).status).toBe(204);
    expect((await api("reactions.add", { channel: channel.id, timestamp: "1.1", name: "eyes" })).body.error).toBe(
      "message_not_found",
    );

    await post("/faults", { type: "latency", delay: 250, times: 1 });
    const started = Date.now();
    expect((await api("auth.test")).body.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  test("faults a session set are gone when it closes", async () => {
    const { h, api, sessionId, post } = await workspace();
    await post("/faults", { type: "error", error: "fatal_error" });
    expect((await api("auth.test")).body.error).toBe("fatal_error");
    await h.call("DELETE", `/sessions/${sessionId}`);
    expect((await api("auth.test")).body.ok).toBe(true);
  });

  test("uninstalling tells the app, revokes its token, and is undone when the session closes", async () => {
    const { h, agent, api, sessionId, say, post } = await workspace();
    const deliveries = await post("/uninstall");
    await h.app.settled();

    expect(deliveries.map((delivery: { eventType: string }) => delivery.eventType)).toEqual([
      "app_uninstalled",
      "tokens_revoked",
    ]);
    expect(agent.received.map((delivery) => JSON.parse(delivery.body).event.type)).toEqual([
      "app_uninstalled",
      "tokens_revoked",
    ]);
    expect((await api("auth.test")).body).toEqual({ ok: false, error: "account_inactive" });
    expect((await say("@my-agent anyone?")).delivery).toBeUndefined();
    expect((await post("/uninstall")).error).toBe("account_inactive");

    await h.call("DELETE", `/sessions/${sessionId}`);
    expect((await api("auth.test")).body.ok).toBe(true);
    const next = await open(h);
    expect((await next.say("@my-agent back?")).delivery.eventType).toBe("app_mention");
  });
});

describe("quiet", () => {
  test("the session is busy while a delivery is pending or a stream is open, and quiet since its last event after", async () => {
    const { h, agent, api, ana, team, channel, sessionId, say } = await workspace();
    const quiet = async () => (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    agent.respond = () => ({ status: 200, delayMs: 200 });

    const question = await say("@my-agent write the notes");
    expect(await quiet()).toEqual({ busy: true, quietForMs: 0 });
    await h.app.settled();
    expect((await quiet()).busy).toBe(false);

    const stream = (
      await api("chat.startStream", {
        channel: channel.id,
        thread_ts: question.ts,
        recipient_user_id: ana.id,
        recipient_team_id: team.id,
      })
    ).body;
    await h.app.settled();
    expect(await quiet()).toEqual({ busy: true, quietForMs: 0 });
    await api("chat.stopStream", { channel: channel.id, ts: stream.ts });
    await h.app.settled();

    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = await quiet();
    expect(after.busy).toBe(false);
    expect(after.quietForMs).toBeGreaterThanOrEqual(100);
    expect(after.quietForMs).toBeLessThan(5000);
    expect((await h.call("GET", "/sessions/ses_none/quiet")).body.error).toBe("session_not_found");
  });
});

describe("what a person sees", () => {
  test("thread status: working while a status line is set, streaming while a stream is open, idle after", async () => {
    const { api, ana, team, channel, say, get } = await workspace();
    const question = await say("@my-agent write the notes");
    const status = () => get(`/conversations/${channel.id}/threads/${question.ts}/state`);
    const thread = { channel_id: channel.id, thread_ts: question.ts };

    expect(await status()).toEqual({ state: "idle" });
    await api("assistant.threads.setStatus", { ...thread, status: "is thinking…" });
    expect(await status()).toEqual({ state: "working", text: "is thinking…" });

    const stream = (
      await api("chat.startStream", {
        channel: channel.id,
        thread_ts: question.ts,
        recipient_user_id: ana.id,
        recipient_team_id: team.id,
      })
    ).body;
    // Starting to answer clears the status line, as on Slack.
    expect(await status()).toEqual({ state: "streaming" });
    await api("chat.appendStream", { channel: channel.id, ts: stream.ts, markdown_text: "## 0.10" });
    const [reply] = await get(`/conversations/${channel.id}/threads/${question.ts}/replies`);
    expect(reply.stream).toMatchObject({ state: "open", chunks: ["## 0.10"] });

    await api("chat.stopStream", { channel: channel.id, ts: stream.ts });
    expect(await status()).toEqual({ state: "idle", sessionStatus: "active" });
    const [done] = await get(`/conversations/${channel.id}/threads/${question.ts}/replies`);
    expect(done.stream).toMatchObject({ state: "completed", endedAt: expect.any(String) });

    await api("agents.sessions.setStatus", { ...thread, status: "processing" });
    expect(await status()).toEqual({ state: "working", sessionStatus: "processing" });
  });

  test("the transcript reads like the conversation: names, block text, buttons, edits, and ephemeral only for its recipient", async () => {
    const { api, app, ana, channel, say, get, post } = await workspace();
    const question = await say("@my-agent deploy web to staging");
    await post(`/users/${ana.id}/edit`, {
      text: { text: "@my-agent deploy web to production" },
      message: { channel: channel.id, ts: question.ts },
    });
    await api("chat.postMessage", {
      channel: channel.id,
      thread_ts: question.ts,
      text: "",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Deploy *web* for <@${ana.id}>?` } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "approve" },
            { type: "static_select", placeholder: { type: "plain_text", text: "Environment" }, action_id: "env" },
          ],
        },
      ],
    });
    await api("chat.postEphemeral", {
      channel: channel.id,
      user: ana.id,
      thread_ts: question.ts,
      text: "Only admins can approve",
    });

    const thread = `/conversations/${channel.id}/threads/${question.ts}/transcript`;
    const lines = (transcript: { entries: Array<{ author: { name: string }; text: string }> }) =>
      transcript.entries.map((entry) => `${entry.author.name}: ${entry.text}`);

    const forEveryone = await get(thread);
    expect(lines(forEveryone)).toEqual(["Ana: @my-agent deploy web to production", "my-agent: Deploy *web* for @Ana?"]);
    expect(forEveryone.entries[0]).toMatchObject({
      edited: true,
      depth: 0,
      controls: [],
      author: { id: ana.id, kind: "user" },
    });
    expect(forEveryone.entries[1]).toMatchObject({
      edited: false,
      depth: 1,
      controls: ["Approve", "Environment"],
      author: { id: app.id, kind: "app" },
    });

    const forAna = await get(`${thread}?as=${ana.id}`);
    expect(lines(forAna).at(-1)).toBe("my-agent: Only admins can approve");
    expect(forAna.entries.at(-1).visibleTo).toMatchObject({ id: ana.id });
    expect((await get(`/users/${ana.id}/ephemeral`)).map((message: { text: string }) => message.text)).toEqual([
      "Only admins can approve",
    ]);
    expect(lines(await get(`/conversations/${channel.id}/transcript`))).toHaveLength(2);
  });
});
