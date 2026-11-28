import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DRIVERS } from "../../src/drivers/index.ts";
import { cli, type RunningBinary, startBinary, temporaryHome } from "./harness.ts";

const running: RunningBinary[] = [];
const start = async (...args: Parameters<typeof startBinary>) => {
  const server = await startBinary(...args);
  running.push(server);
  return server;
};
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
});

const posix = process.platform !== "win32";

/** Can a TCP connection be opened to this address? */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    for (const event of ["error", "timeout"] as const) {
      socket.once(event, () => {
        socket.destroy();
        resolve(false);
      });
    }
  });
}

describe("exit check 0.1: the control API needs the token", () => {
  test("status is 200 with the token and 401 without it or with a wrong one", async () => {
    const server = await start();

    const ok = await server.control("GET", "/status");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      ready: true,
      version: cli(["--version"]).stdout.trim(),
      drivers: DRIVERS.map((driver) => driver.name),
    });

    for (const token of [null, "not-the-token", `${server.token}x`, server.token.slice(0, -1)]) {
      const refused = await server.control("GET", "/status", undefined, token);
      expect(refused.status).toBe(401);
      expect(refused.body.error).toBe("unauthorized");
    }
    expect((await server.control("POST", "/sessions", undefined, null)).status).toBe(401);
    expect((await server.control("POST", "/reset", undefined, null)).status).toBe(401);
    expect((await server.control("GET", "/env", undefined, null)).status).toBe(401);
  });

  test("the server listens on loopback only", async () => {
    const server = await start();
    const port = Number(new URL(server.url).port);
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    expect(await reachable("127.0.0.1", port)).toBe(true);

    const others = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal && address.family === "IPv4")
      .map((address) => address?.address as string);
    // CI machines always have a network interface; a laptop in flight mode may not.
    if (process.env.CI) expect(others.length).toBeGreaterThan(0);
    for (const address of others) expect(await reachable(address, port), `${address}:${port} must refuse`).toBe(false);
  });

  test.runIf(posix)(
    "exit check 0.6: the token file and secrets.json are private, and the token file goes away on stop",
    async () => {
      const server = await start();
      for (const name of ["server.json", "secrets.json"])
        expect(statSync(join(server.home, name)).mode & 0o777).toBe(0o600);
      expect(statSync(server.home).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(join(server.home, "server.json"), "utf8"))).toMatchObject({
        url: server.url,
        pid: server.child.pid,
      });

      expect(await server.stop()).toBe(0);
      expect(existsSync(join(server.home, "server.json"))).toBe(false);
      expect(existsSync(join(server.home, "secrets.json"))).toBe(true);
    },
  );

  test("every start gets a new bearer token; the fake secrets stay", async () => {
    const first = await start();
    const env = (await first.control("GET", "/env")).body;
    await first.stop();
    const second = await start({ home: first.home });
    expect(second.token).not.toBe(first.token);
    expect((await second.control("GET", "/env")).body.ECHO_APP_TOKEN).toBe(env.ECHO_APP_TOKEN);
    expect((await second.control("GET", "/status", undefined, first.token)).status).toBe(401);
  });
});

describe("the CLI", () => {
  test("env prints the agent's .env lines from the running server", async () => {
    const server = await start();
    const { status, stdout } = cli(["env"], { CHANNELSTACK_HOME: server.home });
    expect(status).toBe(0);
    expect(stdout).toMatch(new RegExp(`^ECHO_API_URL=${server.url}/echo$`, "m"));
    expect(stdout).toMatch(/^ECHO_APP_TOKEN=echo_app_[A-Za-z0-9]{40}$/m);
    expect(stdout).toMatch(/^ECHO_SIGNING_SECRET=[a-f0-9]{64}$/m);

    const noServer = cli(["env"], { CHANNELSTACK_HOME: temporaryHome() });
    expect(noServer.status).toBe(1);
    expect(noServer.stderr).toContain("no running server found");
  });

  test("exit check 0.6: secrets rotate changes every value", () => {
    const home = temporaryHome();
    const secrets = () =>
      JSON.parse(readFileSync(join(home, "secrets.json"), "utf8")).secrets as Record<string, Record<string, string>>;
    expect(cli(["secrets", "rotate"], { CHANNELSTACK_HOME: home }).status).toBe(0);
    const before = secrets();
    expect(cli(["secrets", "rotate"], { CHANNELSTACK_HOME: home }).status).toBe(0);
    const after = secrets();

    expect(Object.keys(after.echo ?? {}).sort()).toEqual(["appToken", "signingSecret"]);
    for (const [driver, values] of Object.entries(before)) {
      for (const [name, value] of Object.entries(values)) expect(after[driver]?.[name]).not.toBe(value);
    }
    if (posix) expect(statSync(join(home, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  test("bad input is refused with a message and exit code 1", () => {
    expect(cli(["frobnicate"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('unknown command "frobnicate"'),
    });
    expect(cli(["secrets", "show"])).toMatchObject({ status: 1 });
    expect(cli(["start", "--port", "http"])).toMatchObject({ status: 1, stderr: expect.stringContaining("--port") });
    expect(cli(["slack", "say", "--thead", "last"])).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("channelstack slack say takes no --thead"),
    });
    expect(cli(["slak"])).toMatchObject({ status: 1, stderr: expect.stringContaining("`channelstack slack`") });
  });

  test("help is per command, and never acts or attaches", () => {
    const noServer = { CHANNELSTACK_HOME: temporaryHome() };
    const top = cli(["--help"], noServer);
    expect(top).toMatchObject({ status: 0, stderr: "" });
    expect(top.stdout).toMatch(/^ {2}secrets +Replace every fake token/m);
    expect(top.stdout).not.toContain("--as <name>");

    const slack = cli(["slack", "--help"], noServer);
    expect(slack.stdout).toMatch(/^ {2}click +Click a button/m);
    expect(cli(["help", "slack"], noServer).stdout).toBe(slack.stdout);
    // A group named alone shows its help.
    expect(cli(["slack"], noServer)).toMatchObject({ status: 0, stdout: slack.stdout });

    // `--help` wins over everything else on the line: nothing is said, no server is needed.
    const say = cli(["slack", "say", "--as", "ana", "--in", "#support", "hi", "-h"], noServer);
    expect(say).toMatchObject({ status: 0, stderr: "" });
    expect(say.stdout).toContain("channelstack slack say --as <name> --in <place> <text>");
  });

  test("a private server file gets its own token, and the shared one is left alone", async () => {
    const shared = await start();
    const privateFile = join(temporaryHome(), "private.json");
    const second = await start({
      home: shared.home,
      args: ["--no-portless", "--port", "0", "--server-file", privateFile],
      serverFile: privateFile,
    });

    expect(second.url).not.toBe(shared.url);
    expect(second.token).not.toBe(shared.token);
    expect((await second.control("GET", "/status")).status).toBe(200);
    expect((await second.control("GET", "/status", undefined, shared.token)).status).toBe(401);
    if (posix) expect(statSync(privateFile).mode & 0o777).toBe(0o600);
    // Both servers accept the same fake tokens: the agent is configured once per install.
    expect((await second.control("GET", "/env")).body.ECHO_APP_TOKEN).toBe(
      (await shared.control("GET", "/env")).body.ECHO_APP_TOKEN,
    );

    expect(await second.stop()).toBe(0);
    expect(existsSync(privateFile)).toBe(false);
    expect(JSON.parse(readFileSync(join(shared.home, "server.json"), "utf8")).token).toBe(shared.token);
    expect((await shared.control("GET", "/status")).status).toBe(200);
  });

  test("a second default server is refused while the first one answers, and takes over once it is gone", async () => {
    const first = await start();
    await expect(startBinary({ home: first.home })).rejects.toThrow(
      /already running at http:\/\/127\.0\.0\.1:\d+ \(pid \d+, from .*server\.json\).*--server-file/s,
    );
    // The refused start changed nothing for the first server.
    expect(JSON.parse(readFileSync(join(first.home, "server.json"), "utf8")).token).toBe(first.token);
    expect((await first.control("GET", "/status")).status).toBe(200);

    // A server that was killed leaves its file behind; the next start replaces it.
    first.child.kill("SIGKILL");
    await new Promise((resolve) => first.child.once("exit", resolve));
    expect(existsSync(join(first.home, "server.json"))).toBe(true);
    const next = await start({ home: first.home });
    expect(next.token).not.toBe(first.token);
    expect((await next.control("GET", "/status")).status).toBe(200);
  });

  test("a stale server file doesn't block a start, even when its pid belongs to a live process", async () => {
    const home = temporaryHome();
    // This test's own pid: alive, and not a channelstack server. Nothing listens at the URL.
    const stale = {
      url: "http://127.0.0.1:9",
      local: "http://127.0.0.1:9",
      token: "stale-token",
      pid: process.pid,
      version: "0.0.0",
    };
    writeFileSync(join(home, "server.json"), JSON.stringify(stale));

    const server = await start({ home });

    expect(server.token).not.toBe("stale-token");
    expect((await server.control("GET", "/status")).status).toBe(200);
  });

  test.runIf(posix).each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s stops the server cleanly and removes its token file",
    async (signal) => {
      const server = await start();
      const exited = new Promise<number | null>((resolve) => server.child.once("exit", (code) => resolve(code)));
      server.child.kill(signal);
      expect(await exited).toBe(0);
      expect(existsSync(join(server.home, "server.json"))).toBe(false);
    },
  );

  test.runIf(posix)("a server whose token file was damaged still stops cleanly", async () => {
    const portlessLog = join(temporaryHome(), "calls.log");
    const bin = temporaryHome();
    writeFileSync(join(bin, "portless"), `#!/bin/sh\necho "$@" >> "${portlessLog}"\n`);
    chmodSync(join(bin, "portless"), 0o755);
    const server = await start({ args: [], env: { PATH: `${bin}${delimiter}${process.env.PATH}` } });
    writeFileSync(join(server.home, "server.json"), "{trunc");

    expect(await server.stop()).toBe(0);
    // The names are still removed, and the damaged file, which isn't provably this server's, is left alone.
    expect(readFileSync(portlessLog, "utf8")).toContain("alias --remove channelstack");
    expect(readFileSync(join(server.home, "server.json"), "utf8")).toBe("{trunc");
  });

  test("a secrets.json that isn't JSON stops the start with a message that names the file", async () => {
    const home = temporaryHome();
    writeFileSync(join(home, "secrets.json"), '{"version":1,"secr');
    await expect(startBinary({ home })).rejects.toThrow(/secrets\.json is not valid JSON\. Delete it/);
  });
});

describe.runIf(posix)("portless", () => {
  function fakePortless(exitCode = 0) {
    const bin = temporaryHome();
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "portless"), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${exitCode}\n`);
    chmodSync(join(bin, "portless"), 0o755);
    return {
      path: `${bin}${delimiter}${process.env.PATH}`,
      calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    };
  }

  test("the *.localhost names are registered on start and removed on stop", async () => {
    const portless = fakePortless();
    const server = await start({ args: [], env: { PATH: portless.path } });

    expect(server.url).toBe("https://channelstack.localhost");
    // One name for the UI and control API, and one per driver, all on the server's one port.
    const names = ["channelstack", ...DRIVERS.map((driver) => driver.name)];
    const registered = portless.calls();
    const port = registered[0]?.split(" ")[2];
    expect(port).toMatch(/^\d+$/);
    expect(registered).toEqual(names.map((name) => `alias ${name} ${port}`));
    // The names point at the loopback port the server really listens on.
    const direct = await fetch(`http://127.0.0.1:${port}/_channelstack/status`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(direct.status).toBe(200);

    expect(await server.stop()).toBe(0);
    expect(portless.calls().slice(names.length)).toEqual(names.map((name) => `alias --remove ${name}`));
  });

  test("a failing or missing portless stops the start with a clear message", async () => {
    const failing = fakePortless(3);
    await expect(startBinary({ args: [], env: { PATH: failing.path } })).rejects.toThrow(
      /portless alias channelstack \d+ exited with 3/,
    );

    const emptyPath = temporaryHome();
    await expect(startBinary({ args: [], env: { PATH: emptyPath } })).rejects.toThrow(
      /portless isn't installed.*--no-portless/,
    );
  });
});
