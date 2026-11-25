import { spawn } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** The stand-in agent through the tap: what it sent the parent, its output and its exit code. */
async function runTapped(options: { closeChannel?: boolean } = {}) {
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "scripts", "lib", "slack-event-tap.ts"),
      join(ROOT, "test", "acceptance", "stand-ins", "slack-agent.ts"),
    ],
    { stdio: ["ignore", "pipe", "inherit", "ipc"] },
  );
  const messages: unknown[] = [];
  child.on("message", (message) => messages.push(message));
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  if (options.closeChannel) child.disconnect();
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { messages, output, code };
}

// The differential run starts Slack's reference agent through the tap (decision 0020, #28): each
// event Slack sends it reaches the live run first, and Bolt still handles it as it came.
test("the Slack event tap hands each event to the parent, and the agent still handles it", async () => {
  const { messages, output, code } = await runTapped();
  expect(code).toBe(0);
  expect(messages).toEqual([
    {
      slackEvent: {
        type: "event_callback",
        team_id: "T0STANDIN",
        api_app_id: "A0STANDIN",
        event: { type: "app_mention", text: "hi", user: "U0PERSON", channel: "C0STANDIN", ts: "1.2" },
      },
    },
  ]);
  expect(output).toContain("handled hi");
});

test("with the parent's channel closed, the agent still handles the event and exits cleanly", async () => {
  const { messages, output, code } = await runTapped({ closeChannel: true });
  expect(messages).toEqual([]);
  expect(output).toContain("handled hi");
  expect(code).toBe(0);
});
