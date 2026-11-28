import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { notionDev } from "./dev.ts";
import { createNotionFake } from "./fake/index.ts";
import { NOTION_IDS } from "./ids.ts";
import { removeNotionEntry } from "./live/cleanup.ts";
import { NotionRestClient } from "./live/client.ts";
import { notionMaintenance } from "./live/maintenance.ts";
import { createLiveNotionWorld } from "./live/world.ts";
import { notionPlace } from "./place.ts";
import { registerNotionRoutes } from "./routes.ts";
import { NOTION_SECRETS } from "./secrets.ts";

/** The Notion driver: the fake REST API and its webhooks, and the control actions a test's people take. */
export const notion: DriverDefinition = {
  name: "notion",
  title: "Notion",
  place: notionPlace,
  dev: notionDev,
  ids: NOTION_IDS,
  tokenPatterns: [/ntn_[A-Za-z0-9]{20,}/g, /secret_[A-Za-z0-9]{20,}/g],
  hosts: ["api.notion.com"],
  secrets: { token: NOTION_SECRETS.token, verificationToken: NOTION_SECRETS.verificationToken },
  // The integration's token in a test workspace (live-mode.md, section 4). People bring their own tokens.
  live: {
    credentials: ["CHANNELSTACK_NOTION_TOKEN"],
    allowlist: "CHANNELSTACK_LIVE_NOTION_WORKSPACES",
    maintenance: notionMaintenance,
  },
  create(context): Driver {
    const fake = createNotionFake(context);
    const client = new NotionRestClient({ base: context.live.apiBase, fetch: context.live.fetch });
    const live = context.live.active
      ? createLiveNotionWorld({
          client,
          live: context.live,
          ids: context.ids,
          clock: context.clock,
          appName: fake.store.bot.name,
        })
      : undefined;
    if (live) {
      context.live.ledger.onCleanup("notion", (entry) =>
        removeNotionEntry(client, (owner) => live.credential(owner, entry.session), entry),
      );
    }
    return {
      name: "notion",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerNotionRoutes(router, {
          fake: fake.world,
          live,
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
      // Live, `channelstack env` prints nothing for Notion (app.ts): the agent talks to it with its own configuration.
      env: () => ({
        NOTION_BASE_URL: context.apiUrl(),
        NOTION_TOKEN: context.secret("token"),
        NOTION_VERIFICATION_TOKEN: context.secret("verificationToken"),
      }),
    };
  },
};
