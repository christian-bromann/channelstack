import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";
import { waitFor, WaitTimeoutError } from "../../sdks/typescript/runtime/wait.ts";

// Issue #61: when the agent dies during a test, the test says so, and doesn't only report what it
// was waiting for. What it was waiting for is still there, as the cause.
test("a test whose agent exited says so, with what it waited for as the cause", async () => {
  const agent = join(ROOT, "test", "acceptance", "stand-ins", "short-lived-agent.ts");
  const failed = await withStack(
    {
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      agent,
      webhook: { driver: "slack", path: "/slack/events" },
    },
    () => waitFor("a reply that never comes", async () => undefined, { timeout: "2s" }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(Error);
  expect((failed as Error).message).toBe(`The agent ${agent} exited with 3 during the test`);
  expect((failed as Error).cause).toBeInstanceOf(WaitTimeoutError);
});
