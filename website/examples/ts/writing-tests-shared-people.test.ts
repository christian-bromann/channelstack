// @show:start
import type { SlackConversation, SlackUser } from "channelstack";
import { expect, test as base } from "vitest";

// In a project, this goes in test/fixtures.ts, exported, and the tests import `test` from there.
const test = base.extend<{ ana: SlackUser; ben: SlackUser; support: SlackConversation }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  ben: async ({ slack }, use) => use(await slack.createUser({ name: "Ben", admin: true })),
  support: async ({ slack, ana, ben }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, ben, slack.app] })),
});

test("an admin and a regular member see the same answer", async ({ support, ana, ben }) => {
  const question = await ana.say("@my-agent who's on call?", { channel: support });
  await ben.reply("+1, also need this", { thread: question });

  await expect(question.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});
// @show:end
