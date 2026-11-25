import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadCa, type ProxyCa } from "../ca/index.ts";
import { createLogger } from "../log/index.ts";
import { Redactor } from "../redact/index.ts";
import { type RunningProxy, startProxy } from "./index.ts";

const log = createLogger({ level: "error", redactor: new Redactor(), write: () => {} });
const listen = async (server: HttpServer) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

let home: string;
let ca: ProxyCa;
let proxy: RunningProxy;
let fake: HttpServer;
let internet: HttpServer;
const seen: string[] = [];
const headersSeen: Array<Record<string, string | string[] | undefined>> = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "channelstack-proxy-"));
  ca = await loadCa(home, ["slack.com", "api.github.com"]);
  // The server's TLS listener, as the fakes serve it: it says which host it was asked for.
  fake = createHttpsServer(await ca.issue(["slack.com", "api.github.com"]), (request, response) => {
    response.end(`fake ${request.headers.host} ${request.url}`);
  });
  const fakePort = await listen(fake);
  // A stand-in for the rest of the internet.
  internet = createHttpServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.host}`);
    headersSeen.push(request.headers);
    response.end(`internet ${request.url}`);
  });
  const internetPort = await listen(internet);
  proxy = await startProxy({
    port: 0,
    log,
    route: (host) =>
      ["slack.com", "api.github.com"].includes(host) ? { host: "127.0.0.1", port: fakePort } : undefined,
    passThrough: () => ({ host: "127.0.0.1", port: internetPort }),
  });
});
afterAll(async () => {
  await proxy.stop();
  fake.close();
  internet.close();
  rmSync(home, { recursive: true, force: true });
});

/** Everything the proxy sends back until it closes, or `ms` passes. */
const answer = (socket: Socket, ms = 2_000) =>
  new Promise<string>((resolve) => {
    let text = "";
    const done = () => resolve(text);
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    socket.on("close", done);
    socket.on("error", done);
    setTimeout(done, ms);
  });

/** Send raw bytes to the proxy and read what it answers. */
const raw = async (bytes: string) => {
  const socket = connectTcp(proxy.port, "127.0.0.1");
  socket.write(bytes);
  const text = await answer(socket);
  socket.destroy();
  return text;
};

/** CONNECT through the proxy, then TLS with only channelstack's CA trusted, then one request. */
async function viaConnect(host: string, path: string): Promise<string> {
  const socket = connectTcp(proxy.port, "127.0.0.1");
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nhost: ${host}:443\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    socket.once("data", (chunk) =>
      chunk.toString().startsWith("HTTP/1.1 200") ? resolve() : reject(new Error(chunk.toString())),
    );
  });
  const tls = connectTls({ socket, servername: host, ca: [ca.cert] });
  await new Promise<void>((resolve, reject) => tls.once("secureConnect", resolve).once("error", reject));
  tls.write(`GET ${path} HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
  const text = await answer(tls);
  tls.destroy();
  return text.slice(text.indexOf("\r\n\r\n") + 4);
}

describe("the proxy", () => {
  test("listens on loopback only", () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("a CONNECT to a routed host reaches the fake, with a certificate the agent's CA trusts", async () => {
    expect(await viaConnect("slack.com", "/api/auth.test")).toBe("fake slack.com /api/auth.test");
    expect(await viaConnect("api.github.com", "/repos/a/b")).toBe("fake api.github.com /repos/a/b");
  });

  test("a CONNECT to any other host is a tunnel to that host, untouched", async () => {
    const socket = connectTcp(proxy.port, "127.0.0.1");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\nhost: example.com:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    // Through the tunnel, the bytes reach the other side as they were sent.
    socket.write("GET /through HTTP/1.1\r\nhost: example.com\r\nconnection: close\r\n\r\n");
    expect(await answer(socket)).toContain("internet /through");
    expect(seen).toContain("GET /through example.com");
  });

  test("plain HTTP for another host is passed on in origin form; a routed host is HTTPS only", async () => {
    expect(
      await raw("GET http://example.com/plain?x=1 HTTP/1.1\r\nhost: example.com\r\nconnection: close\r\n\r\n"),
    ).toContain("internet /plain?x=1");
    expect(seen).toContain("GET /plain?x=1 example.com");
    // Headers for the proxy don't go on, and the origin closes after its answer.
    await raw(
      "GET http://example.com/headers HTTP/1.1\r\nhost: example.com\r\nproxy-authorization: Basic eA==\r\nproxy-connection: keep-alive\r\n\r\n",
    );
    expect(headersSeen.at(-1)).toMatchObject({ connection: "close" });
    expect(Object.keys(headersSeen.at(-1) ?? {}).filter((name) => name.startsWith("proxy-"))).toEqual([]);
    expect(await raw("GET http://slack.com/api/auth.test HTTP/1.1\r\nhost: slack.com\r\n\r\n")).toMatch(
      /^HTTP\/1\.1 403/,
    );
  });

  test("what isn't a proxy request is refused", async () => {
    expect(await raw("CONNECT slack.com:8443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403/);
    expect(await raw("CONNECT not a target HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw("hello\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw("GET /relative HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw(`GET http://example.com/ HTTP/1.1\r\nx: ${"a".repeat(20_000)}`)).toMatch(/^HTTP\/1\.1 431/);
  });

  test("stopping it ends the tunnels it holds", async () => {
    const other = await startProxy({
      port: 0,
      log,
      route: () => undefined,
      passThrough: () => ({ host: "127.0.0.1", port: (internet.address() as AddressInfo).port }),
    });
    const socket = connectTcp(other.port, "127.0.0.1");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await other.stop();
    await closed;
  });
});
