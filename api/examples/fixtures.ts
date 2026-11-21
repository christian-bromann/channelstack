import { test as base } from "vitest";
import type { SlackUser, SlackChannel } from "channelstack";
export const test = base.extend<{ ana: SlackUser; ben: SlackUser; support: SlackChannel }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  ben: async ({ slack }, use) => use(await slack.createUser({ name: "Ben", admin: true })),
  support: async ({ slack, ana, ben }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, ben, slack.app] })),
});
