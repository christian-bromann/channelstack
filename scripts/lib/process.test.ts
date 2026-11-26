import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it, test, vi } from "vitest";

// The address each probe server bound, read from the server once it listens.
const probed = vi.hoisted((): string[] => []);
vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>();
  return {
    ...net,
    createServer: (...args: Parameters<typeof net.createServer>) => {
      const server = net.createServer(...args);
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address === "object") probed.push(address.address);
      });
      return server;
    },
  };
});

const { freePort } = await import("./process.ts");

/** Listen on `port` the way Bolt and the Go agent do: no host, so every interface. */
const listenLikeAnAgent = (port: number) =>
  new Promise<() => Promise<void>>((resolve, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen(port, () => resolve(() => new Promise((done) => server.close(() => done()))));
  });

const COUNT = 400;
const CLAIMS = join(tmpdir(), `channelstack-ports-${process.getuid?.() ?? "user"}`);
const MODULE = pathToFileURL(join(import.meta.dirname, "process.ts")).href;

/** A process that takes `COUNT` ports, prints them, and runs until its stdin closes. */
function taker(): ChildProcessByStdio<Writable, Readable, null> {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { freePort } = await import(${JSON.stringify(MODULE)});
       const ports = [];
       for (let i = 0; i < ${COUNT}; i++) ports.push(await freePort());
       console.log(JSON.stringify(ports));
       process.stdin.resume();`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
}

/** The ports a taker printed. */
async function portsOf(child: ChildProcessByStdio<Writable, Readable, null>): Promise<number[]> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("\n")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`the taker exited with ${code}`)));
  });
  return JSON.parse(output) as number[];
}

/** This process's claims, by the pid in their names. */
const claimsOf = (pid: number | undefined) => readdirSync(CLAIMS).filter((name) => name.split("-")[1] === String(pid));

// Issue #61: Vitest runs each test file in its own worker, so two stacks can start side by side in
// two processes. Each must get a port of its own, or the second agent can't listen, and its test
// talks to the first one's agent.
test(
  "two processes never get the same port, and give their claims up when they exit",
  { timeout: 30_000 },
  async () => {
    const first = taker();
    const second = taker();
    try {
      // The first one takes its ports and keeps running while the second takes its own.
      const theirs = new Set(await portsOf(first));
      const ours = await portsOf(second);
      expect(new Set(ours).size).toBe(COUNT);
      expect(ours.filter((port) => theirs.has(port))).toEqual([]);
      expect(claimsOf(first.pid)).toHaveLength(COUNT);
    } finally {
      for (const child of [first, second]) {
        child.stdin.end();
        if (child.exitCode === null) await once(child, "exit");
      }
    }
    expect([...claimsOf(first.pid), ...claimsOf(second.pid)]).toEqual([]);
  },
);

// A Vitest worker ends without an `exit` event, and can't give its claims up: once its process is
// gone, they count for nothing, and the next process to claim a port removes them.
test("the claims of a process that is gone lapse", { timeout: 30_000 }, async () => {
  const killed = taker();
  await portsOf(killed);
  // While it runs, nothing removes its claims.
  expect(claimsOf(killed.pid)).toHaveLength(COUNT);
  killed.kill("SIGKILL");
  await once(killed, "exit");
  const next = taker();
  try {
    await portsOf(next);
    expect(claimsOf(killed.pid)).toEqual([]);
  } finally {
    next.stdin.end();
    if (next.exitCode === null) await once(next, "exit");
  }
});

// A claim whose port turns out to be in use is given up: it would only hold a port nobody can have.
test("a port that is in use leaves no claim behind", { timeout: 30_000 }, async () => {
  // Listeners on about one port in 40 of the range, so the taker's probe finds some of them in use.
  const listeners: Server[] = [];
  for (let port = 20_000; port <= 32_767; port += 40) {
    const server = createServer();
    const listened = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, () => resolve(true));
    });
    if (listened) listeners.push(server);
  }
  const child = taker();
  try {
    const ports = await portsOf(child);
    expect(ports.filter((port) => (port - 20_000) % 40 === 0)).toEqual([]);
    expect(claimsOf(child.pid)).toHaveLength(COUNT);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, "exit");
    for (const server of listeners) server.close();
  }
});

describe("freePort", () => {
  it("probes every interface, not loopback alone", async () => {
    probed.length = 0;
    await freePort();
    // More than one probe when a port it drew was in use; each of them on every interface.
    expect(probed.length).toBeGreaterThan(0);
    // `::` where IPv6 is on, `0.0.0.0` where it is off: never a single interface like 127.0.0.1.
    for (const address of probed) expect(["::", "0.0.0.0"]).toContain(address);
  });

  it("hands out each port once, and each one can be bound", async () => {
    const ports = await Promise.all(Array.from({ length: 20 }, () => freePort()));
    expect(new Set(ports).size).toBe(ports.length);
    const closes = await Promise.all(ports.map(listenLikeAnAgent));
    await Promise.all(closes.map((close) => close()));
  });
});
