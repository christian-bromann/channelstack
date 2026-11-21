import { afterEach, describe, expect, test } from "vitest";

import { slackWorkspace } from "../../../test/slack-workspace.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A workspace whose app connects the way a Socket Mode client does: ask for a URL, open it, acknowledge envelopes. */
async function workspace() {
  const space = await slackWorkspace();
  closers.push(space.agent.close);
  const { h, app } = space;
  const openUrl = async (token: string = app.appToken) =>
    (await h.provider("POST", "slack/api/apps.connections.open", {}, token)).body;

  /** Connect, and collect what the fake sends. `acks` decides what each envelope is acknowledged with. */
  const connect = async (acks: (envelope: any) => unknown = () => undefined) => {
    const { url } = await openUrl();
    const session = h.app.socket(new Request(url.replace(/^ws/, "http")));
    if (!session) throw new Error("The fake refused the connection");
    const received: any[] = [];
    let closed = false;
    session.open({
      send(text) {
        const message = JSON.parse(text);
        received.push(message);
        // A client acknowledges every envelope, optionally with an answer.
        if (message.envelope_id) {
          const payload = acks(message);
          queueMicrotask(() =>
            session.message(JSON.stringify({ envelope_id: message.envelope_id, ...(payload ? { payload } : {}) })),
          );
        }
      },
      close() {
        closed = true;
        session.closed();
      },
    });
    return {
      url,
      received,
      envelopes: () => received.filter((message) => message.envelope_id),
      isClosed: () => closed,
    };
  };
  return { ...space, openUrl, connect };
}

describe("Socket Mode", () => {
  test("K1: the app asks for a connection with its app-level token and connects with a one-time ticket", async () => {
    const { h, app, openUrl, connect, get } = await workspace();
    // A token of the wrong kind is told so; something that is no token at all is just refused.
    expect((await openUrl(app.botToken)).error).toBe("not_allowed_token_type");
    expect((await openUrl("xapp-made-up")).error).toBe("invalid_auth");
    expect((await h.provider("POST", "slack/api/auth.test", {}, app.appToken)).body.error).toBe(
      "not_allowed_token_type",
    );

    const { url, received } = await connect();
    expect(url).toMatch(
      new RegExp(`^ws://127\\.0\\.0\\.1:4500/slack/link/\\?ticket=[A-Za-z0-9_-]{20,}&app_id=${app.id}$`),
    );
    expect(received[0]).toMatchObject({ type: "hello", num_connections: 1, connection_info: { app_id: app.id } });
    expect((await get("")).socketConnections).toBe(1);
    // The ticket is spent, and a made-up one opens nothing.
    expect(h.app.socket(new Request(url.replace(/^ws/, "http")))).toBeUndefined();
    expect(h.app.socket(new Request("http://127.0.0.1:4500/slack/link/?ticket=made-up"))).toBeUndefined();
  });

  test("K2: an event arrives as an events_api envelope, and the ack settles the delivery", async () => {
    const { h, agent, app, connect, say, get } = await workspace();
    const { envelopes } = await connect();

    const message = await say("@my-agent hi");
    await h.app.settled();

    const [mention] = envelopes();
    expect(mention).toMatchObject({
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: { type: "event_callback", api_app_id: app.id, event: { type: "app_mention", ts: message.ts } },
    });
    expect(mention.envelope_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await get(`/deliveries/${message.delivery.id}`)).toMatchObject({
      status: "acknowledged",
      attempts: [{ transport: "socket", url: "ws://127.0.0.1:4500/slack/link", status: "acknowledged" }],
    });
    // An app in Socket Mode gets nothing at its request URL.
    expect(agent.received).toHaveLength(0);
  });

  test("K4: a slash command is a slash_commands envelope, and the ack carries the immediate reply", async () => {
    const { h, ana, channel, connect, post, get } = await workspace();
    const { envelopes } = await connect((envelope) =>
      envelope.type === "slash_commands"
        ? { response_type: "in_channel", text: "Deploying web to staging" }
        : undefined,
    );

    const command = await post(`/users/${ana.id}/commands`, { command: "/deploy web staging", channel: channel.id });
    await h.app.settled();

    expect(envelopes()[0]).toMatchObject({
      type: "slash_commands",
      accepts_response_payload: true,
      payload: { command: "/deploy", text: "web staging", user_id: ana.id, channel_id: channel.id },
    });
    expect((await get(`/deliveries/${command.id}`)).attempts[0]).toMatchObject({
      transport: "socket",
      responseBody: '{"response_type":"in_channel","text":"Deploying web to staging"}',
    });
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe("my-agent: Deploying web to staging");
  });

  test("a click is an interactive envelope with the payload itself, not a form", async () => {
    const { h, ana, channel, api, connect, post } = await workspace();
    const { envelopes } = await connect();
    const blocks = [
      { type: "actions", elements: [{ type: "button", action_id: "go", text: { type: "plain_text", text: "Go" } }] },
    ];
    await api("chat.postMessage", { channel: channel.id, text: "Ready?", blocks });
    await h.app.settled();

    await post(`/users/${ana.id}/click`, { button: { label: "Go" }, channel: channel.id });
    await h.app.settled();
    expect(envelopes().at(-1)).toMatchObject({
      type: "interactive",
      accepts_response_payload: true,
      payload: { type: "block_actions", actions: [{ action_id: "go" }] },
    });
  });

  test("when the connection drops, what is sent meanwhile waits for the app to reconnect", async () => {
    const { h, connect, say, post, get } = await workspace();
    const first = await connect();

    await post("/faults", { type: "drop_socket" });
    expect(first.isClosed()).toBe(true);
    expect((await get("")).socketConnections).toBe(0);

    const message = await say("still there?");
    expect((await get(`/deliveries/${message.delivery.id}`)).status).toBe("pending");
    const second = await connect();
    await h.app.settled();
    expect(second.envelopes()[0]).toMatchObject({ type: "events_api", payload: { event: { text: "still there?" } } });
    expect((await get(`/deliveries/${message.delivery.id}`)).status).toBe("acknowledged");
    expect(first.envelopes()).toHaveLength(0);
  });

  test("drop_socket with `after` cuts the connection later", async () => {
    const { h, connect, post } = await workspace();
    const connection = await connect();
    await post("/faults", { type: "drop_socket", after: 2000 });
    h.timers.advance(1999);
    expect(connection.isClosed()).toBe(false);
    h.timers.advance(1);
    expect(connection.isClosed()).toBe(true);
  });
});
