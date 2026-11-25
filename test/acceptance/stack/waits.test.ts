import { expect, test } from "vitest";

import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";

// Two waits with different filters on one fixture: each keeps its own place, so the second one
// finds a call that was already there when the first one returned.
test("waitForCall with one filter doesn't hide calls from a wait with another", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent look at this", { channel });
  await expect(msg.thread).toHaveReplyFrom("my-agent");

  const post = await slack.waitForCall({ operation: "chat.postMessage" });
  const reaction = await slack.waitForCall({ operation: "reactions.add" }, { timeout: "2s" });
  expect([post.operation, reaction.operation]).toEqual(["chat.postMessage", "reactions.add"]);
});

// A modal that was closed stays in the person's list (`open: false`), so that a wait which
// remembers its place finds a second modal. A wait that hasn't looked yet must still skip it (#13).
test("waitForModal finds the open modal, not one already closed", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent file an incident", { channel });

  await ana.click("Open form", { thread: msg.thread });
  const first = await waitFor("the first modal", async () => (await ana.modals())[0]);
  await first.close();

  await ana.click("Open form", { thread: msg.thread });
  const modal = await ana.waitForModal({ title: /incident/i });
  expect(modal.viewId).not.toBe(first.viewId);
  expect(modal.open).toBe(true);
});
