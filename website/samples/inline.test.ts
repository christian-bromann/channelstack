/**
 * The short snippets written inline in the page copy (src/pages/Home.tsx, src/components/Flow.tsx)
 * are not imported from a sample file. This file exercises each of them, so `pnpm typecheck:samples`
 * fails when the API they quote changes. Keep it in step with those snippets.
 */
import { test, expect } from "vitest";

test("the calls quoted in the page copy exist", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  // "ana.say(…)" and "expect(thread)"
  const message = await ana.say("@robin hi", { channel });
  const thread = message.thread;

  // "toHaveRepliesFrom(…, { count: 1 })"
  await expect(thread).toHaveRepliesFrom("robin", { count: 1 });
  // "not.toContainText"
  await expect(thread).not.toContainText("Thinking…");
  // 'ana.click("Approve", { message })'
  await ana.click("Approve", { message });
});
