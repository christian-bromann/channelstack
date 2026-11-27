import type { SlackConversation, SlackUser } from "channelstack";
import { test as base } from "vitest";
export const test = base.extend<{ ana: SlackUser; ben: SlackUser; support: SlackConversation }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  ben: async ({ slack }, use) => use(await slack.createUser({ name: "Ben", admin: true })),
  support: async ({ slack, ana, ben }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, ben, slack.app] })),
});
