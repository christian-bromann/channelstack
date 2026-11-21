import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { type Harness, harness, TOKEN } from "../test/app-harness.ts";
import { signEchoDelivery } from "./core/signing/echo.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The echo provider API, as the echo agent calls it. */
const echoAgent = (
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token = h.secrets.get("echo", "appToken"),
) => h.provider(method, `echo${path}`, body, token);

async function world(h: Harness) {
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/echo`;
  const fixture = (await h.call("GET", base)).body;
  const ana = (await h.call("POST", `${base}/users`, { name: "Ana" })).body;
  const room = (await h.call("POST", `${base}/rooms`, { participants: [ana.id, fixture.app.id] })).body;
  return { sessionId, base, fixture, ana, room };
}

describe("control API", () => {
  test("every route needs the bearer token", async () => {
    const h = harness();
    expect((await h.call("GET", "/status")).body).toEqual({
      ready: true,
      version: "0.0.0-test",
      drivers: ["echo", "slack"],
    });
    for (const token of [null, "wrong-token-0123456789", `${TOKEN}x`]) {
      const refused = await h.call("GET", "/status", undefined, token);
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: "unauthorized", message: "Missing or wrong bearer token", data: {} });
    }
    expect((await h.call("POST", "/sessions", undefined, null)).status).toBe(401);
    expect((await h.call("GET", "/nope", undefined, null)).status).toBe(401);
    expect((await h.call("GET", "/nope")).body.error).toBe("not_found");
  });

  test("errors use the protocol's codes", async () => {
    const h = harness();
    const { base } = await world(h);
    expect((await h.call("GET", "/sessions/ses_missing/echo")).body.error).toBe("session_not_found");
    expect((await h.call("DELETE", "/sessions/ses_missing")).status).toBe(404);
    const invalid = await h.call("POST", `${base}/users`, { name: "" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_argument");
    expect(invalid.body.data.issues[0].path).toBe("name");
    expect((await h.call("POST", `${base}/users`, "{not json")).status).toBe(400);
    expect((await h.call("GET", `${base}/rooms/ER0000000000/messages`)).body.error).toBe("not_found");
    expect((await h.call("GET", `/sessions/${base.split("/")[2]}/events?since=bogus`)).body.error).toBe(
      "invalid_argument",
    );
  });

  test("the OpenAPI document carries the SDK extensions", () => {
    const doc = harness().app.openapi() as any;
    const say = doc.paths["/sessions/{session}/echo/users/{user}/say"].post;
    expect(say["x-channelstack-method"]).toEqual({ on: "EchoUser", name: "say", args: ["text"], options: ["room"] });
    expect(say["x-channelstack-error-codes"]).toEqual([
      "unauthorized",
      "invalid_argument",
      "internal",
      "session_not_found",
      "not_found",
      "not_in_room",
    ]);
    expect(say["x-channelstack-stability"]).toBe("experimental");
    expect(doc.paths["/sessions"].post["x-channelstack-factory"]).toEqual({
      on: "Channelstack",
      name: "openSession",
      options: ["name"],
    });
    expect(doc.components.schemas.EchoUser["x-channelstack-resource"]).toEqual({ id: "id" });
    expect(doc.components.schemas.EchoSayBody.properties.room["x-channelstack-ref"]).toEqual(["EchoRoom"]);
    expect(doc.components.securitySchemes.bearer).toEqual({ type: "http", scheme: "bearer" });
  });

  test("env hands the agent its fake credentials and API URL", async () => {
    const h = harness();
    expect((await h.call("GET", "/env")).body).toMatchObject({
      ECHO_API_URL: "http://127.0.0.1:4500/echo",
      ECHO_APP_TOKEN: h.secrets.get("echo", "appToken"),
      ECHO_SIGNING_SECRET: h.secrets.get("echo", "signingSecret"),
      SLACK_API_URL: "http://127.0.0.1:4500/slack/api/",
      SLACK_BOT_TOKEN: h.secrets.get("slack", "botToken"),
      SLACK_SIGNING_SECRET: h.secrets.get("slack", "signingSecret"),
    });
  });
});

describe("sessions are scopes in one shared world", () => {
  test("a session can't see another session's objects, and closing it removes them", async () => {
    const h = harness();
    const one = await world(h);
    const two = await world(h);
    expect(two.fixture.app).toEqual(one.fixture.app);
    expect(two.ana.id).not.toBe(one.ana.id);

    const foreign = await h.call("POST", `${two.base}/users/${one.ana.id}/say`, { text: "hi", room: two.room.id });
    expect(foreign.body.error).toBe("not_found");
    expect((await h.call("GET", `${two.base}/rooms/${one.room.id}/messages`)).body.error).toBe("not_found");
    expect((await h.call("POST", `${two.base}/rooms`, { participants: [one.ana.id] })).body.error).toBe("not_found");

    await h.call("POST", `${one.base}/users/${one.ana.id}/say`, { text: "mine", room: one.room.id });
    const events = (await h.call("GET", `/sessions/${two.sessionId}/events`)).body.events;
    expect(events.map((event: any) => event.data.action)).toEqual(["createUser", "createRoom"]);

    expect((await h.call("DELETE", `/sessions/${one.sessionId}`)).status).toBe(204);
    expect((await h.call("GET", `/sessions/${one.sessionId}/events`)).body.error).toBe("session_not_found");
    expect((await echoAgent(h, "POST", "/api/messages", { room: one.room.id, text: "late" })).body).toEqual({
      ok: false,
      error: "room_not_found",
    });
  });

  test("reset drops the world and seeds a new app", async () => {
    const h = harness();
    const before = await world(h);
    expect((await h.call("POST", "/reset")).status).toBe(204);
    expect((await h.call("GET", before.base)).body.error).toBe("session_not_found");
    const after = await world(h);
    expect(after.fixture.app.id).not.toBe(before.fixture.app.id);
  });
});

describe("the echo pipeline", () => {
  test("the platform refuses what it should, with its own error codes", async () => {
    const h = harness();
    const { base, ana, room } = await world(h);
    const ben = (await h.call("POST", `${base}/users`, { name: "Ben" })).body;
    const outsider = await h.call("POST", `${base}/users/${ben.id}/say`, { text: "hi", room: room.id });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe("not_in_room");

    const quiet = (await h.call("POST", `${base}/rooms`, { participants: [ana.id] })).body;
    expect((await echoAgent(h, "POST", "/api/messages", { room: quiet.id, text: "x" })).body).toEqual({
      ok: false,
      error: "not_in_room",
    });
    expect((await echoAgent(h, "POST", "/api/messages", { room: room.id, text: "x" }, "echo_app_wrong")).status).toBe(
      401,
    );
    expect((await echoAgent(h, "POST", "/api/messages", { room: room.id })).body.error).toBe("invalid_payload");
    expect((await echoAgent(h, "GET", "/api/rooms/ER0000000000/messages")).body.error).toBe("room_not_found");
    expect((await echoAgent(h, "GET", "/api/nope")).body.error).toBe("unknown_method");
  });

  test("a message is signed, delivered, answered through the provider API, and all of it is in the event log", async () => {
    const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const agent = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    servers.push(agent);
    await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
    const h = harness({ echo: `http://127.0.0.1:${(agent.address() as AddressInfo).port}/events` });
    const { sessionId, base, fixture, ana, room } = await world(h);

    const message = (await h.call("POST", `${base}/users/${ana.id}/say`, { text: "hello", room: room.id })).body;
    await h.app.settled();

    expect(message).toMatchObject({ room: room.id, text: "hello", author: { id: ana.id, name: "Ana", kind: "user" } });
    expect(message.delivery).toMatch(/^ED[0-9A-Z]{10}$/);
    expect(received).toHaveLength(1);
    const delivered = received[0]!;
    const timestamp = String(delivered.headers["x-echo-request-timestamp"]);
    const expected = signEchoDelivery(h.secrets.get("echo", "signingSecret"), delivered.body, Number(timestamp) * 1000);
    expect(delivered.headers["x-echo-signature"]).toBe(expected["x-echo-signature"]);
    expect(JSON.parse(delivered.body)).toMatchObject({
      type: "message.created",
      event_id: message.delivery,
      app_id: fixture.app.id,
      message: { text: "hello" },
    });

    const reply = await echoAgent(h, "POST", "/api/messages", { room: room.id, text: "echo: hello" });
    expect(reply.body.message.author).toEqual({ id: fixture.app.id, name: "echo-agent", kind: "app" });
    expect((await echoAgent(h, "GET", `/api/rooms/${room.id}/messages`)).body.messages).toHaveLength(2);

    const first = (await h.call("GET", `${base}/rooms/${room.id}/messages`)).body;
    expect(first.messages.map((m: any) => m.text)).toEqual(["hello", "echo: hello"]);
    expect((await h.call("GET", `${base}/rooms/${room.id}/messages?since=${first.cursor}`)).body.messages).toEqual([]);
    const transcript = (await h.call("GET", `${base}/rooms/${room.id}/transcript`)).body;
    expect(transcript.entries.map((e: any) => `${e.author.name}: ${e.text}`)).toEqual([
      "Ana: hello",
      "echo-agent: echo: hello",
    ]);
    expect((await h.call("GET", `${base}/capabilities`)).body.say).toEqual({
      fake: true,
      live: false,
      liveRequires: [],
    });

    const { events, cursor } = (await h.call("GET", `/sessions/${sessionId}/events`)).body;
    expect(events.map((event: any) => event.kind)).toEqual([
      "action",
      "action",
      "action",
      "delivery",
      "delivery_attempt",
      "api_call",
      "api_call",
    ]);
    const attempt = events[4].data;
    expect(attempt).toMatchObject({
      id: message.delivery,
      number: 1,
      transport: "http",
      status: "acknowledged",
      responseStatus: 200,
      responseBody: "ok",
    });
    expect(events[5].data).toMatchObject({
      operation: "messages.create",
      responseStatus: 200,
      request: { room: room.id, text: "echo: hello" },
    });
    expect((await h.call("GET", `/sessions/${sessionId}/events?since=${cursor}`)).body.events).toEqual([]);
  });

  test("delivery outcomes: a failing agent, an unreachable one, and no endpoint at all", async () => {
    const failing = createServer((_req, res) => res.writeHead(500).end("boom"));
    servers.push(failing);
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const port = (failing.address() as AddressInfo).port;

    const statusOf = async (webhook: string | undefined) => {
      const h = harness({ echo: webhook });
      const { sessionId, base, ana, room } = await world(h);
      const message = (await h.call("POST", `${base}/users/${ana.id}/say`, { text: "hi", room: room.id })).body;
      await h.app.settled();
      const events = (await h.call("GET", `/sessions/${sessionId}/events`)).body.events;
      return {
        delivery: message.delivery,
        attempt: events.find((event: any) => event.kind === "delivery_attempt")?.data,
      };
    };

    expect((await statusOf(`http://127.0.0.1:${port}/events`)).attempt).toMatchObject({
      status: "failed",
      responseStatus: 500,
    });
    expect((await statusOf("http://127.0.0.1:1/events")).attempt).toMatchObject({ status: "unreachable" });
    expect(await statusOf(undefined)).toEqual({ delivery: undefined, attempt: undefined });
  });

  test("nothing secret reaches the log or the event log", async () => {
    const h = harness({ echo: "http://127.0.0.1:1/events" });
    const { sessionId, base, ana, room } = await world(h);
    const token = h.secrets.get("echo", "appToken");
    await h.call("POST", `${base}/users/${ana.id}/say`, { text: `my token is ${token}`, room: room.id });
    await echoAgent(h, "POST", "/api/messages", { room: room.id, text: `leaking ${token}` });
    await h.app.settled();

    const recorded = JSON.stringify((await h.call("GET", `/sessions/${sessionId}/events`)).body);
    expect(recorded).not.toContain(token);
    expect(recorded).toContain("[redacted]");
    expect(h.logs.join("\n")).not.toContain(token);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  test("with portless, each driver is its own host", async () => {
    const h = harness();
    const { room } = await world(h);
    const response = await h.app.fetch(
      new Request(`http://echo.localhost/api/rooms/${room.id}/messages`, {
        headers: { authorization: `Bearer ${h.secrets.get("echo", "appToken")}` },
      }),
    );
    expect(await response.json()).toEqual({ ok: true, messages: [] });
    const forwarded = await h.app.fetch(
      new Request("http://127.0.0.1:4500/api/nope", { headers: { "x-forwarded-host": "echo.localhost" } }),
    );
    expect(await forwarded.json()).toEqual({ ok: false, error: "unknown_method" });
    expect(h.app.hosts()).toEqual(["channelstack", "echo", "slack"]);
    expect((await h.app.fetch(new Request("http://127.0.0.1:4500/elsewhere"))).status).toBe(404);
  });
});

describe("named sessions", () => {
  test("a session opened by name is shared until it closes; unnamed ones are always new", async () => {
    const h = harness();
    const open = async (body?: unknown) => (await h.call("POST", "/sessions", body)).body.sessionId;
    const dev = await open({ name: "dev" });
    expect(await open({ name: "dev" })).toBe(dev);
    expect(await open({ name: "other" })).not.toBe(dev);
    expect(await open()).not.toBe(await open());

    await h.call("DELETE", `/sessions/${dev}`);
    expect(await open({ name: "dev" })).not.toBe(dev);
    expect((await h.call("POST", "/sessions", { name: "Not A Name" })).body.error).toBe("invalid_argument");
  });
});

describe("the UI", () => {
  const open = (h: Harness, path: string, cookie?: string) =>
    h.app.fetch(new Request(`http://127.0.0.1:4500${path}`, cookie ? { headers: { cookie } } : {}));
  /** Open a login link the way a browser does, and keep the cookie it sets. */
  async function login(h: Harness) {
    const link = new URL(h.app.uiLoginLink());
    const response = await open(h, `${link.pathname}${link.search}`);
    return { link, response, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }

  test("a login link works once and leaves a cookie scripts can't read", async () => {
    const h = harness();
    expect((await open(h, "/")).status).toBe(401);

    const { link, response, cookie } = await login(h);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toMatch(
      /^channelstack_ui=[A-Za-z0-9_-]{20,}; Path=\/; HttpOnly; SameSite=Strict$/,
    );

    // The code in the link is spent: a second visit, or a made-up code, gets nothing.
    expect((await open(h, `${link.pathname}${link.search}`)).headers.get("set-cookie")).toBeNull();
    expect((await open(h, "/?login=made-up")).status).toBe(401);
    expect((await open(h, "/", "channelstack_ui=made-up")).status).toBe(401);

    const page = await open(h, "/", cookie);
    expect(page.status).toBe(200);
    const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
    // The page gets this response's nonce and the shared dev session.
    const { sessionId } = (await h.call("POST", "/sessions", { name: "dev" })).body;
    expect(await page.text()).toBe(`<script nonce="${nonce}">const session = "${sessionId}";</script>`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  test("the browser session reads what the UI shows and nothing else", async () => {
    const h = harness();
    const { cookie } = await login(h);
    const { sessionId } = (await h.call("POST", "/sessions", { name: "dev" })).body;
    const as = (method: string, path: string) =>
      h.app.fetch(new Request(`http://127.0.0.1:4500/_channelstack${path}`, { method, headers: { cookie } }));

    for (const path of ["/status", `/sessions/${sessionId}/events`, `/sessions/${sessionId}/slack/conversations`]) {
      expect((await as("GET", path)).status, path).toBe(200);
    }
    // What the browser reads is scrubbed: a token someone pasted into a message doesn't show in the UI.
    const slack = `/sessions/${sessionId}/slack`;
    const ana = (await h.call("POST", `${slack}/users`, { name: "Ana" })).body;
    const channel = (await h.call("POST", `${slack}/channels`, { participants: [ana.id] })).body;
    const botToken = h.secrets.get("slack", "botToken");
    await h.call("POST", `${slack}/users/${ana.id}/say`, {
      message: { text: `my token is ${botToken}` },
      channel: channel.id,
    });
    const transcript = `${slack}/conversations/${channel.id}/transcript`;
    expect((await h.call("GET", transcript)).body.text).toBe(`Ana: my token is ${botToken}`);
    expect(((await (await as("GET", transcript)).json()) as { text: string }).text).toBe("Ana: my token is [redacted]");

    // Not the agent's tokens, and no writes: a page that tricks the browser into a request gains nothing.
    for (const [method, path] of [
      ["GET", "/env"],
      ["GET", `/sessions/${sessionId}/slack`],
      ["POST", "/sessions"],
      ["POST", "/reset"],
      ["POST", "/ui/login-links"],
      ["DELETE", `/sessions/${sessionId}`],
      ["POST", `/sessions/${sessionId}/slack/users`],
    ] as const) {
      expect((await as(method, path)).status, `${method} ${path}`).toBe(401);
    }
    // The CLI asks for a fresh link with the bearer token.
    expect((await h.call("POST", "/ui/login-links")).body.url).toMatch(
      /^http:\/\/127\.0\.0\.1:4500\/\?login=[A-Za-z0-9_-]{20,}$/,
    );
  });
});
