import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { freePort } from "./process.ts";

const COUNT = 400;

// Issue #61: Vitest runs each test file in its own worker, so two stacks can start side by side in
// two processes. Each must get a port of its own, or the second agent can't listen, and its test
// talks to the first one's agent.
test("two processes never get the same port", { timeout: 30_000 }, async () => {
  const module = pathToFileURL(join(import.meta.dirname, "process.ts")).href;
  // The other process takes its ports and keeps running until this one has taken its own.
  const other = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { freePort } = await import(${JSON.stringify(module)});
       const ports = [];
       for (let i = 0; i < ${COUNT}; i++) ports.push(await freePort());
       console.log(JSON.stringify(ports));
       process.stdin.resume();`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  try {
    let output = "";
    other.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      other.stdout.on("data", () => output.includes("\n") && resolve());
      other.once("exit", (code) => reject(new Error(`the other process exited with ${code}`)));
    });
    const theirs = new Set(JSON.parse(output) as number[]);
    const ours: number[] = [];
    for (let i = 0; i < COUNT; i++) ours.push(await freePort());
    expect(new Set(ours).size).toBe(COUNT);
    expect(ours.filter((port) => theirs.has(port))).toEqual([]);
  } finally {
    other.stdin.end();
    if (other.exitCode === null) await once(other, "exit");
  }
});
