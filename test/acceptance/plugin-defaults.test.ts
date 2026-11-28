import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";

// What the Vitest plugin's options do in a project that uses only the plugin, run in a child
// Vitest against one server: the test timeout it sets, and the defaults it gives the SDK's waits.
let server: Awaited<ReturnType<typeof startBinary>>;
beforeAll(async () => {
  server = await startBinary({
    bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
    env: { CHANNELSTACK_LOG_LEVEL: "warn" },
  });
}, 30_000);
afterAll(() => server?.stop());

/** Run one of the projects beside this file, and what it printed. */
function runProject(project: string): { status: number | null; output: string } {
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", `test/acceptance/${project}/vitest.config.ts`, "--reporter", "verbose"],
    { cwd: ROOT, env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" }, encoding: "utf8" },
  );
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

// No `testTimeout` of its own: a check that fails after its default 10s wait reports its own
// message, not Vitest's "Test timed out in 5000ms" (the plugin raises the test timeout).
test("a failing check reports its own message within the default config", () => {
  const { status, output } = runProject("default-timeout");
  expect(status, output).toBe(1);
  expect(output).toMatch(/1 failed/);
  expect(output).toContain("Expected a reply from my-agent. The thread has:");
  expect(output).not.toContain("Test timed out");
}, 60_000);

// `channelstack({ timeout: "1s" })`: `waitForReply()` and `waitForMessage()` give up after 1s.
test("the plugin's timeout is every SDK wait's default", () => {
  const { status, output } = runProject("wait-defaults");
  expect(status, output).toBe(0);
  expect(output).toMatch(/1 passed/);
}, 60_000);

// Exit check 12.6: a test that left a bot loop fails, though it checked nothing. Two scripted apps
// answer each other past the loop guard, and the fixture fails the test with the fake's message.
const STOPPED =
  /The fake stopped a bot loop in slack \S+ \(50 app messages with no person between them: loop-p[io]ng → loop-p[io]ng/;

test("the Vitest fixture fails a test that left a bot loop", () => {
  const { status, output } = runProject("bot-loop");
  expect(status, output).toBe(1);
  expect(output).toMatch(/1 failed/);
  expect(output).toMatch(STOPPED);
}, 60_000);

test("the pytest fixture fails a test that left a bot loop", () => {
  const run = spawnSync(
    "uv",
    ["run", "--project", "integrations/pytest-channelstack", "--frozen", "pytest", "test/acceptance/bot-loop"],
    { cwd: ROOT, env: { ...process.env, CHANNELSTACK_HOME: server.home, NO_COLOR: "1" }, encoding: "utf8" },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.status, output).toBe(1);
  expect(output).toMatch(/1 (failed|error)/);
  expect(output).toMatch(STOPPED);
}, 60_000);
