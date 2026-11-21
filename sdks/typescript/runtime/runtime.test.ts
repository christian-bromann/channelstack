import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { connectWith, sessionOf } from "./client.ts";
import { parseDuration } from "./duration.ts";
import { resolveServerBinary, serverBinaryName, serverPackageName } from "./launcher.ts";
import { ChannelstackError, segment, Transport } from "./transport.ts";
import { waitFor, WaitTimeoutError } from "./wait.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(
  handler: (request: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    body: string;
  }) => [number, unknown?],
) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const [status, payload] = handler({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(payload === undefined ? "" : JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("durations", () => {
  test("milliseconds, or a number with a unit", () => {
    expect([
      parseDuration(250),
      parseDuration("250ms"),
      parseDuration("3s"),
      parseDuration("1m"),
      parseDuration("1.5s"),
    ]).toEqual([250, 250, 3000, 60_000, 1500]);
  });

  test("anything else is refused", () => {
    for (const bad of ["3 s", "soon", "3h", "", "-1s"])
      expect(() => parseDuration(bad as never)).toThrow(/Not a duration/);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => parseDuration(bad)).toThrow(/Not a duration/);
  });
});

describe("waiting", () => {
  test("it polls until there is a value", async () => {
    let reads = 0;
    const value = await waitFor("the third read", async () => (++reads >= 3 ? `read ${reads}` : undefined), {
      interval: 1,
    });
    expect(value).toBe("read 3");
  });

  test("it gives up after the timeout and says what it waited for", async () => {
    const started = Date.now();
    await expect(
      waitFor("a reply from my-agent", async () => undefined, { timeout: "60ms", interval: "10ms" }),
    ).rejects.toThrow(new WaitTimeoutError("a reply from my-agent", 60));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an error from the read is not swallowed", async () => {
    await expect(waitFor("x", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("transport", () => {
  class NotFoundError extends ChannelstackError {}
  const transport = (url: string) =>
    new Transport({ url, token: "t0ken", basePath: "/_channelstack", errors: { not_found: NotFoundError } });

  test("requests carry the bearer token, the base path, JSON bodies and query parameters", async () => {
    const seen: unknown[] = [];
    const url = await serve((request) => {
      seen.push([
        request.method,
        request.url,
        request.headers.authorization,
        request.headers["content-type"],
        request.body,
      ]);
      return request.method === "DELETE" ? [204] : [200, { ok: true }];
    });
    const client = transport(url);

    expect(
      await client.request("POST", `/rooms/${segment("a/b c")}`, {
        body: { text: "hi", skipped: undefined },
        query: { since: "c_1", none: undefined },
      }),
    ).toEqual({ ok: true });
    expect(await client.request("DELETE", "/sessions/s")).toBeUndefined();
    expect(seen).toEqual([
      ["POST", "/_channelstack/rooms/a%2Fb%20c?since=c_1", "Bearer t0ken", "application/json", '{"text":"hi"}'],
      ["DELETE", "/_channelstack/sessions/s", "Bearer t0ken", undefined, ""],
    ]);
  });

  test("protocol errors become typed exceptions", async () => {
    const url = await serve((request) =>
      request.url.endsWith("/known")
        ? [404, { error: "not_found", message: "No such room", data: { room: "R1" } }]
        : request.url.endsWith("/new")
          ? [418, { error: "brand_new_code", message: "?" }]
          : [502, undefined],
    );
    const client = transport(url);

    const known = await client.request("GET", "/known").catch((error: unknown) => error);
    expect(known).toBeInstanceOf(NotFoundError);
    expect(known).toMatchObject({
      name: "NotFoundError",
      code: "not_found",
      status: 404,
      message: "No such room",
      data: { room: "R1" },
    });
    // A code this SDK doesn't know yet still surfaces, as the base error.
    expect(await client.request("GET", "/new").catch((error: unknown) => error)).toMatchObject({
      name: "ChannelstackError",
      code: "brand_new_code",
      status: 418,
    });
    expect(await client.request("GET", "/gateway").catch((error: unknown) => error)).toMatchObject({
      code: "internal",
      status: 502,
      message: "HTTP 502",
    });
  });

  test("a response that isn't JSON is a ChannelstackError, not a SyntaxError", async () => {
    const server = createServer((_request, response) =>
      response.writeHead(502, { "content-type": "text/html" }).end("<h1>Bad gateway</h1>"),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const error = await transport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      .request("GET", "/status")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChannelstackError);
    expect(error).toMatchObject({ code: "internal", status: 502, message: "HTTP 502: the response is not JSON" });
  });

  test("a connection that drops after the request was sent is not retried, so a POST never runs twice", async () => {
    let requests = 0;
    const server = createServer((request) => {
      requests++;
      request.socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const started = Date.now();

    await expect(
      transport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`).request("POST", "/sessions", {
        body: {},
      }),
    ).rejects.toThrow(TypeError);

    expect(requests).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a connection that is refused is retried while the server starts", async () => {
    const url = await serve(() => [200, { ready: true }]);
    const server = servers[0] as Server;
    const port = (server.address() as AddressInfo).port;
    await new Promise((resolve) => server.close(resolve));
    setTimeout(() => server.listen(port, "127.0.0.1"), 300);
    expect(await transport(url).request("GET", "/status")).toEqual({ ready: true });
  });
});

describe("connecting", () => {
  const protocol = (version: string) => ({ basePath: "/_channelstack", errors: {}, version });

  test("the SDK refuses a server with another major version", async () => {
    const url = await serve(() => [200, { ready: true, version: "2.1.0" }]);
    process.env.CHANNELSTACK_TOKEN = "t";
    try {
      const connect = (version: string) =>
        connectWith((transport) => transport, protocol(version), { mode: "attach", server: url });
      expect(await connect("2.0.0")).toBeInstanceOf(Transport);
      await expect(connect("1.4.0")).rejects.toThrow(
        "The channelstack server is version 2.1.0, but this SDK was generated for 1.4.0",
      );
    } finally {
      delete process.env.CHANNELSTACK_TOKEN;
    }
  });

  test("only handles in a session have one", () => {
    const transport = new Transport({ url: "http://127.0.0.1:1", token: "t", ...protocol("0.0.0") });
    expect(sessionOf({ transport, session: "ses_1" })).toBe("ses_1");
    expect(() => sessionOf({ transport, session: undefined })).toThrow(/doesn't belong to a session/);
  });
});

describe("the server binary", () => {
  test("each platform has its own package, in the npm naming for os and cpu", () => {
    expect(serverPackageName("darwin", "arm64")).toBe("@channelstack/server-darwin-arm64");
    expect(serverPackageName("win32", "x64")).toBe("@channelstack/server-win32-x64");
    expect([serverBinaryName("linux"), serverBinaryName("win32")]).toEqual(["channelstack", "channelstack.exe"]);
  });

  test("CHANNELSTACK_SERVER_BIN wins; without a binary the error says what to do", () => {
    expect(resolveServerBinary({ CHANNELSTACK_SERVER_BIN: "/opt/channelstack" })).toBe("/opt/channelstack");
    expect(() => resolveServerBinary({})).toThrow(
      /optional dependency @channelstack\/server-.* isn't installed.*CHANNELSTACK_SERVER_BIN/,
    );
  });
});
