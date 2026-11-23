import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createNotionFake } from "./fake/index.ts";
import { registerNotionRoutes } from "./routes.ts";

/** The Notion driver: the fake REST API and its webhooks, and the control actions a test's people take. */
export const notion: DriverDefinition = {
  name: "notion",
  secrets: { token: "notion.token", verificationToken: "notion.verificationToken" },
  // The integration's token in a test workspace (live-mode.md, section 4). Its live backend isn't
  // built yet: with it set, the driver refuses with unsupported_in_live instead of running fake.
  live: { credentials: ["CHANNELSTACK_NOTION_TOKEN"], allowlist: "CHANNELSTACK_LIVE_NOTION_WORKSPACES" },
  create(context): Driver {
    const fake = createNotionFake(context);
    return {
      name: "notion",
      fake,
      routes: (router) =>
        registerNotionRoutes(router, {
          world: fake.world,
          events: context.events,
          apiUrl: context.apiUrl,
          secret: context.secret,
        }),
      capabilities: () => ({}),
      // An edit Notion is still batching is an event on its way to the agent.
      openWork: (session) =>
        fake.world
          .pendingContent(session)
          .map((page) => `a page.content_updated for "${fake.world.titleOf(page)}" that Notion is still batching`),
      env: () => ({
        NOTION_BASE_URL: context.apiUrl(),
        NOTION_TOKEN: context.secret("token"),
        NOTION_VERIFICATION_TOKEN: context.secret("verificationToken"),
      }),
    };
  },
};
