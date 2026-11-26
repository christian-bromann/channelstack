import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

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
  killed.kill("SIGKILL");
  await once(killed, "exit");
  expect(claimsOf(killed.pid)).toHaveLength(COUNT);
  const next = taker();
  try {
    await portsOf(next);
    expect(claimsOf(killed.pid)).toEqual([]);
  } finally {
    next.stdin.end();
    if (next.exitCode === null) await once(next, "exit");
  }
});
