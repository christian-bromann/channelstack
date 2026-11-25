// @show:start
import type { SlackConversation, SlackUser } from "channelstack";
import { test as base } from "vitest";

export const test = base.extend<{ ana: SlackUser; support: SlackConversation }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  support: async ({ slack, ana }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, slack.app] })),
});
// @show:end
