import { connect, createServer, type Server, type Socket } from "node:net";

import type { Logger } from "../log/index.ts";

/** The only address the proxy binds, like the server: nothing on another machine can use it. */
const LOOPBACK = "127.0.0.1";
/** A request's head may be this long; a longer one is refused, not buffered. */
const MAX_HEAD = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");

/** Where a routed host's connection goes: the server's own TLS listener, which serves the fakes. */
interface ProxyTarget {
  host: string;
  port: number;
}

export interface ProxyOptions {
  /** The loopback port. 0 picks a free one. */
  port: number;
  /**
   * The routed hosts (`slack.com`, `api.github.com`, …) and where each one's connections go. Every
   * other host is tunnelled to the internet untouched.
   */
  route(host: string): ProxyTarget | undefined;
  log: Logger;
  /** Where a host that isn't routed is reached. Tests point it at a stand-in; the default is the host itself. */
  passThrough?(host: string, port: number): ProxyTarget;
}

export interface RunningProxy {
  /** `http://127.0.0.1:<port>`, what `HTTPS_PROXY` is set to. */
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** `host:port` from a CONNECT target or an absolute URL's authority; IPv6 in brackets. */
function authority(text: string, defaultPort: number): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]/\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match?.[1]) return undefined;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host: match[1].replace(/^\[|\]$/g, "").toLowerCase(), port };
}

const refuse = (socket: Socket, status: string, reason: string) => {
  socket.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}\n`);
};

/** Join two sockets both ways until either side closes. */
function pipeBoth(client: Socket, upstream: Socket, rest: Buffer) {
  if (rest.length > 0) upstream.write(rest);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close).on("close", close);
  upstream.on("error", close).on("close", close);
}

/**
 * Proxy mode's HTTP proxy (implementation plan 6.2): what `HTTPS_PROXY` points an agent at. A
 * `CONNECT` to a routed host goes to the server's TLS listener, where channelstack's CA vouches for
 * it and the fake answers; every other `CONNECT` is a plain tunnel to that host. A plain-HTTP
 * request for a host that isn't routed is passed on as it is; one for a routed host is refused,
 * since the platforms are HTTPS only.
 */
export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const passThrough = options.passThrough ?? ((host, port) => ({ host, port }));
  /** Every open socket, both sides: stopping the proxy ends its tunnels too. */
  const open = new Set<Socket>();
  const track = (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    return socket;
  };
  const server: Server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEAD_END);
      if (end === -1) {
        if (head.length > MAX_HEAD) {
          client.off("data", read);
          refuse(client, "431 Request Header Fields Too Large", "The request's head is too long");
        }
        return;
      }
      client.off("data", read);
      client.pause();
      handle(client, head.subarray(0, end + HEAD_END.length), head.subarray(end + HEAD_END.length));
    };
    client.on("data", read);
    client.on("error", () => client.destroy());
  });

  const handle = (client: Socket, head: Buffer, rest: Buffer) => {
    const text = head.toString("latin1");
    const [method, target, version] = (text.slice(0, text.indexOf("\r\n")) || "").split(" ");
    if (!method || !target || !version?.startsWith("HTTP/1.")) {
      return refuse(client, "400 Bad Request", "Not an HTTP/1 request");
    }
    if (method.toUpperCase() === "CONNECT") {
      const to = authority(target, 443);
      if (!to) return refuse(client, "400 Bad Request", "CONNECT needs host:port");
      const routed = options.route(to.host);
      if (routed && to.port !== 443) {
        return refuse(client, "403 Forbidden", `${to.host} is served by channelstack on port 443 only`);
      }
      const destination = routed ?? passThrough(to.host, to.port);
      options.log.debug("proxy connect", { host: to.host, routed: routed !== undefined });
      const upstream = track(
        connect(destination.port, destination.host, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          pipeBoth(client, upstream, rest);
          client.resume();
        }),
      );
      upstream.once("error", () => {
        if (!client.writableEnded) refuse(client, "502 Bad Gateway", `Can't reach ${to.host}:${to.port}`);
      });
      return;
    }
    // An absolute-form request: plain HTTP through the proxy.
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return refuse(client, "400 Bad Request", "A proxy request needs an absolute URL");
    }
    if (url.protocol !== "http:") return refuse(client, "400 Bad Request", "Only http:// is proxied without CONNECT");
    const to = authority(url.host, 80);
    if (!to) return refuse(client, "400 Bad Request", "No host in the URL");
    if (options.route(to.host)) return refuse(client, "403 Forbidden", `${to.host} is served over HTTPS only`);
    const destination = passThrough(to.host, to.port);
    const upstream = track(
      connect(destination.port, destination.host, () => {
        // The origin sees an ordinary request: its path, not the absolute URL, no header meant for
        // the proxy, and one request per connection (a second one on it would still be in proxy form).
        const headers = text
          .slice(text.indexOf("\r\n") + 2, text.length - 4)
          .split("\r\n")
          .filter((header) => header !== "" && !/^(proxy-[\w-]*|connection|keep-alive)\s*:/i.test(header));
        const request = [`${method} ${url.pathname}${url.search} ${version}`, ...headers, "connection: close", "", ""];
        upstream.write(Buffer.from(request.join("\r\n"), "latin1"));
        pipeBoth(client, upstream, rest);
        client.resume();
      }),
    );
    upstream.once("error", () => {
      if (!client.writableEnded) refuse(client, "502 Bad Gateway", `Can't reach ${to.host}:${to.port}`);
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, LOOPBACK, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${LOOPBACK}:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open tunnels end with the proxy: an agent that keeps a connection doesn't hold the server.
        for (const socket of open) socket.destroy();
      }),
  };
}
