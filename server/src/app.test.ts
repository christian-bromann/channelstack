import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { type App, createApp } from "./app.ts";
import { createLogger } from "./core/log/index.ts";
import { Redactor } from "./core/redact/index.ts";
import { Secrets } from "./core/secrets/index.ts";
import { signEchoDelivery } from "./core/signing/echo.ts";
import { secretSpecs } from "./drivers/index.ts";

const TOKEN = "test-token-0123456789";
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

interface Harness {
  app: App;
  secrets: Secrets;
  logs: string[];
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
  agent(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
}

function harness(webhook?: string): Harness {
  const secrets = Secrets.ephemeral(secretSpecs());
  const redactor = new Redactor();
  redactor.register(TOKEN, ...secrets.all());
  const logs: string[] = [];
  const app = createApp({
    version: "0.0.0-test",
    token: TOKEN,
    seed: 1,
    secrets,
    redactor,
    log: createLogger({ level: "debug", redactor, write: (line) => logs.push(line) }),
    urls: () => ({ control: "http://127.0.0.1:4500", driver: (name) => `http://127.0.0.1:4500/${name}` }),
    webhooks: { echo: webhook },
  });
  const send = async (url: string, method: string, body: unknown, token: string | null | undefined) => {
    const response = await app.fetch(
      new Request(url, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    app,
    secrets,
    logs,
    call: (method, path, body, token = TOKEN) =>
      send(`http://127.0.0.1:4500/_channelstack${path}`, method, body, token),
    agent: (method, path, body, token = secrets.get("echo", "appToken")) =>
      send(`http://127.0.0.1:4500/echo${path}`, method, body, token),
  };
}

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
    expect((await h.call("GET", "/status")).body).toEqual({ ready: true, version: "0.0.0-test", drivers: ["echo"] });
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
    expect(doc.paths["/sessions"].post["x-channelstack-factory"]).toEqual({ on: "Channelstack", name: "openSession" });
    expect(doc.components.schemas.EchoUser["x-channelstack-resource"]).toEqual({ id: "id" });
    expect(doc.components.schemas.EchoSayBody.properties.room["x-channelstack-ref"]).toEqual(["EchoRoom"]);
    expect(doc.components.securitySchemes.bearer).toEqual({ type: "http", scheme: "bearer" });
  });

  test("env hands the agent its fake credentials and API URL", async () => {
    const h = harness();
    expect((await h.call("GET", "/env")).body).toEqual({
      ECHO_API_URL: "http://127.0.0.1:4500/echo",
      ECHO_APP_TOKEN: h.secrets.get("echo", "appToken"),
      ECHO_SIGNING_SECRET: h.secrets.get("echo", "signingSecret"),
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
    expect((await h.agent("POST", "/api/messages", { room: one.room.id, text: "late" })).body).toEqual({
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
    expect((await h.agent("POST", "/api/messages", { room: quiet.id, text: "x" })).body).toEqual({
      ok: false,
      error: "not_in_room",
    });
    expect((await h.agent("POST", "/api/messages", { room: room.id, text: "x" }, "echo_app_wrong")).status).toBe(401);
    expect((await h.agent("POST", "/api/messages", { room: room.id })).body.error).toBe("invalid_payload");
    expect((await h.agent("GET", "/api/rooms/ER0000000000/messages")).body.error).toBe("room_not_found");
    expect((await h.agent("GET", "/api/nope")).body.error).toBe("unknown_method");
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
    const h = harness(`http://127.0.0.1:${(agent.address() as AddressInfo).port}/events`);
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

    const reply = await h.agent("POST", "/api/messages", { room: room.id, text: "echo: hello" });
    expect(reply.body.message.author).toEqual({ id: fixture.app.id, name: "echo-agent", kind: "app" });
    expect((await h.agent("GET", `/api/rooms/${room.id}/messages`)).body.messages).toHaveLength(2);

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
      const h = harness(webhook);
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
    const h = harness("http://127.0.0.1:1/events");
    const { sessionId, base, ana, room } = await world(h);
    const token = h.secrets.get("echo", "appToken");
    await h.call("POST", `${base}/users/${ana.id}/say`, { text: `my token is ${token}`, room: room.id });
    await h.agent("POST", "/api/messages", { room: room.id, text: `leaking ${token}` });
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
    expect(h.app.hosts()).toEqual(["channelstack", "echo"]);
    expect((await h.app.fetch(new Request("http://127.0.0.1:4500/elsewhere"))).status).toBe(404);
  });
});
