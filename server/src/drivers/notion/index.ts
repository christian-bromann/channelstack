import { BUILT_IN_APP } from "../../core/apps/index.ts";
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
          secret: (name, app) => context.apps.secret(app ?? BUILT_IN_APP, name),
        }),
      capabilities: () => ({}),
      // An edit Notion is still batching is an event on its way to the agent.
      openWork: (session) =>
        fake.world
          .pendingContent(session)
          .map((page) => `a page.content_updated for "${fake.world.titleOf(page)}" that Notion is still batching`),
      // Live, `channelstack env` prints nothing for Notion (app.ts): the agent talks to it with its own configuration.
      env: (app) => {
        // Another integration's lines have the built-in one's keys, so its agent starts from an .env of the same shape.
        const { apps } = fake.store;
        const name = apps.keyOf(apps.forEnv(app, (wanted) => fake.world.createApp(undefined, { name: wanted })));
        return {
          NOTION_BASE_URL: context.apiUrl(),
          NOTION_TOKEN: context.apps.secret(name, "token"),
          NOTION_VERIFICATION_TOKEN: context.apps.secret(name, "verificationToken"),
        };
      },
    };
  },
};
