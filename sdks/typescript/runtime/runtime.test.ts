import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { connectWith, sessionOf } from "./client.ts";
import { credential } from "./credentials.ts";
import { parseDuration } from "./duration.ts";
import { readChanges, readDocument, readTree, setFilesRoot } from "./files.ts";
import { resolveServerBinary, serverBinaryName, serverPackageName } from "./launcher.ts";
import { ChannelstackError, onRefusal, segment, Transport, unreportedRefusals } from "./transport.ts";
import {
  patternOnWire,
  retryWhile,
  setWaitDefaults,
  untilQuiet,
  waitDefaults,
  waitFor,
  waitForNext,
  WaitTimeoutError,
} from "./wait.ts";

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

  test("a wait for quiet that gives up says what the agent left open", async () => {
    const open = ['a stream my-agent started and never stopped: "Thinking…"'];
    await expect(
      untilQuiet(async () => ({ busy: true, quietForMs: 0, open }), { timeout: "40ms", interval: "10ms" }),
    ).rejects.toThrow(
      'Timed out after 40ms waiting for the agent to be quiet for 750ms. Still open: a stream my-agent started and never stopped: "Thinking…"',
    );
    await expect(
      untilQuiet(async () => ({ busy: false, quietForMs: 10, open: [] }), { timeout: "40ms", interval: "10ms" }),
    ).rejects.toThrow(new WaitTimeoutError("the agent to be quiet for 750ms", 40));
  });

  test("a watching wait for quiet looks for the whole window, however long the agent has been quiet", async () => {
    const longQuiet = async () => ({ busy: false, quietForMs: 60_000, open: [] });
    let started = Date.now();
    await untilQuiet(longQuiet, { quietFor: "80ms", interval: "5ms" });
    expect(Date.now() - started).toBeLessThan(60);

    started = Date.now();
    await untilQuiet(longQuiet, { quietFor: "80ms", interval: "5ms", watching: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  test("a next-wait returns each match once; with turns, only what came after the newest prompt", async () => {
    const items = [
      { type: "response", n: 1 },
      { type: "prompt", n: 2 },
      { type: "response", n: 3 },
    ];
    const read = async () => items;
    const response = (item: { type: string }) => item.type === "response";
    const seen = new Map<string, number>();
    expect((await waitForNext(seen, "w", read, response, "a response")).n).toBe(1);
    expect((await waitForNext(seen, "w", read, response, "a response")).n).toBe(3);
    const prompt = (item: { type: string }) => item.type === "prompt";
    expect((await waitForNext(new Map(), "w", read, response, "a response", {}, prompt)).n).toBe(3);
  });

  test("a pattern goes to the server as its source and flags; a string as it is", () => {
    expect(patternOnWire("Rate limits")).toBe("Rate limits");
    expect(patternOnWire(/rate\s+limits/i)).toEqual({ source: "rate\\s+limits", flags: "i" });
  });

  test("an error from the read is not swallowed", async () => {
    await expect(waitFor("x", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  test("the defaults a test framework sets apply to every wait that isn't given its own", async () => {
    const before = waitDefaults();
    expect(before).toEqual({ timeout: "10s", quietFor: "750ms" });
    setWaitDefaults({ timeout: "40ms", quietFor: "30ms" });
    try {
      await expect(waitFor("a reply", async () => undefined, { interval: "10ms" })).rejects.toThrow(
        new WaitTimeoutError("a reply", 40),
      );
      // A generated `waitFor…` goes through `waitForNext`, a call the server refuses for now through `retryWhile`.
      await expect(
        waitForNext(
          new Map(),
          "w",
          async () => [],
          () => true,
          "a reply",
        ),
      ).rejects.toThrow(new WaitTimeoutError("a reply", 40));
      const refused = Object.assign(new Error("not yet"), { code: "not_found" });
      await expect(retryWhile(["not_found"], () => Promise.reject(refused))).rejects.toBe(refused);
      // `latest…` reads and the reads that wait for quiet take the quiet window too.
      await expect(untilQuiet(async () => ({ busy: false, quietForMs: 30, open: [] }))).resolves.toBeUndefined();
      await expect(untilQuiet(async () => ({ busy: false, quietForMs: 10, open: [] }))).rejects.toThrow(
        new WaitTimeoutError("the agent to be quiet for 30ms", 40),
      );
      // What a call gives still wins.
      await expect(untilQuiet(async () => ({ busy: false, quietForMs: 10, open: [] }), { quietFor: 5 })).resolves.toBe(
        undefined,
      );
      expect(() => setWaitDefaults({ timeout: "soon" as never })).toThrow("Not a duration");
    } finally {
      setWaitDefaults(before);
    }
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

  test("a refusal reaches the refusal hook, unless its read asked to keep it to itself", async () => {
    const url = await serve(() => [422, { error: "action_requires", message: "needs proxy mode" }]);
    const client = transport(url);
    const heard: string[] = [];
    onRefusal((error, path) => heard.push(`${error.code} ${path}`));
    try {
      await expect(client.request("GET", "/sessions/s/quiet")).rejects.toMatchObject({ code: "action_requires" });
      await expect(unreportedRefusals(() => client.request("GET", "/sessions/s/quiet"))).rejects.toMatchObject({
        code: "action_requires",
      });
      expect(heard).toEqual(["action_requires /sessions/s/quiet"]);
    } finally {
      onRefusal(undefined);
    }
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

describe("files a test hands over", () => {
  /** `web/README.md` and `web/src/app.ts` in a new directory, in `parent` when given. */
  const fixture = (parent = tmpdir()) => {
    const root = mkdtempSync(join(parent, "cs-files-"));
    mkdirSync(join(root, "web", "src"), { recursive: true });
    writeFileSync(join(root, "web", "README.md"), "# web\n");
    writeFileSync(join(root, "web", "src", "app.ts"), "export {}\n");
    return root;
  };
  const text = (content: string | null) => (content === null ? null : Buffer.from(content, "base64").toString("utf8"));
  afterEach(() => setFilesRoot(undefined));

  test("a document is its text: inline, or a fixture file's contents from the test's directory", () => {
    const root = fixture();
    setFilesRoot(root);
    expect(readDocument("# inline")).toBe("# inline");
    expect(readDocument({ path: "./web/README.md" })).toBe("# web\n");
    const blocks = [{ type: "divider", divider: {} }];
    expect(readDocument(blocks)).toBe(blocks);
  });

  test("a directory is every file under it, by its path inside it", () => {
    const root = fixture();
    expect(readTree(join(root, "web")).map((file) => [file.path, text(file.content)])).toEqual([
      ["README.md", "# web\n"],
      ["src/app.ts", "export {}\n"],
    ]);
  });

  test("a relative path starts from the root an integration set, or from the working directory", () => {
    const root = fixture();
    setFilesRoot(root);
    expect(readTree("./web").map((file) => file.path)).toEqual(["README.md", "src/app.ts"]);
    expect(readTree([{ path: "web/README.md" }]).map((file) => file.path)).toEqual(["README.md"]);
    setFilesRoot(undefined);
    // Without a root the same path starts from the working directory, where it isn't: an error, not no files.
    expect(() => readTree("./web")).toThrow(/ENOENT/);
    const here = fixture(process.cwd());
    try {
      const relative = basename(here);
      expect(readTree(`${relative}/web`).map((file) => file.path)).toEqual(["README.md", "src/app.ts"]);
      expect(() => readTree(`${relative}/web/README.md`)).toThrow(/ENOTDIR/);
    } finally {
      rmSync(here, { recursive: true });
    }
  });

  test("a list takes inline contents, a file on disk under a name, and a directory under a prefix", () => {
    const root = fixture();
    const files = readTree([
      { name: "notes.txt", content: "hi" },
      { name: "bin/data", content: new Uint8Array([0, 255]) },
      { path: join(root, "web", "README.md") },
      { path: join(root, "web", "README.md"), name: "docs/README.md" },
      { path: join(root, "web", "src"), name: "lib" },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "notes.txt",
      "bin/data",
      "README.md",
      "docs/README.md",
      "lib/app.ts",
    ]);
    expect(Buffer.from(files[1]?.content ?? "", "base64")).toEqual(Buffer.from([0, 255]));
  });

  test("changes are a list of files, or a map of path to contents where null deletes", () => {
    expect(
      readChanges({ "src/app.ts": "export const x = 1\n", "old.ts": null }).map((file) => [
        file.path,
        text(file.content),
      ]),
    ).toEqual([
      ["src/app.ts", "export const x = 1\n"],
      ["old.ts", null],
    ]);
    expect(readChanges([{ name: "a.txt", content: "a" }])).toEqual([{ path: "a.txt", content: "YQ==" }]);
    const root = fixture();
    expect(readChanges([{ path: join(root, "web"), name: "site" }]).map((file) => file.path)).toEqual([
      "site/README.md",
      "site/src/app.ts",
    ]);
  });
});

describe("credentials", () => {
  const variable = "CHANNELSTACK_SLACK_USER_ANA_SMITH_TOKEN";
  afterEach(() => {
    delete process.env[variable];
  });

  test("a person's token comes from CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN, by the name the test gave", () => {
    const template = "CHANNELSTACK_SLACK_USER_{name}_TOKEN";
    expect(credential(template, { name: "Ana Smith" })).toBeUndefined();
    process.env[variable] = "xoxp-from-the-environment";
    expect(credential(template, { name: "Ana Smith" })).toBe("xoxp-from-the-environment");
    expect(credential(template, { name: "ana-smith" })).toBe("xoxp-from-the-environment");
    // Without the name there is nothing to look up, and an empty variable is no credential.
    expect(credential(template, {})).toBeUndefined();
    process.env[variable] = "";
    expect(credential(template, { name: "Ana Smith" })).toBeUndefined();
  });
});
