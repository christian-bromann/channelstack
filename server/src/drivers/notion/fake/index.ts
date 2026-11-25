import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { NOTION_IDS } from "../ids.ts";
import { createNotionApi } from "./api.ts";
import { NotionStore } from "./store.ts";
import { createFakeWorld, type FakeNotionWorld } from "./world.ts";

/** The agent's integration, built in (there is no config file): subscribed to pages and comments, with every capability. */
const DEFAULT_INTEGRATION = {
  name: "my-agent",
  events: [
    "page.created",
    "page.content_updated",
    "page.properties_updated",
    "comment.created",
    "comment.updated",
    "comment.deleted",
  ],
  capabilities: [
    "read_content",
    "update_content",
    "insert_content",
    "read_comments",
    "insert_comments",
    "read_user_info",
  ],
} as const;

export interface NotionFake extends FakeBackend {
  readonly world: FakeNotionWorld;
  readonly store: NotionStore;
}

/** The Notion fake: the REST API over an in-memory workspace, wired to core's ids, event log and delivery queue. */
export function createNotionFake(context: DriverContext): NotionFake {
  const store = new NotionStore(context.registry);
  const world = createFakeWorld(context, store);
  // Who the workspace and the integration are is drawn once: the agent holds their ids from
  // `channelstack env` and its own calls, and a reset builds a new world with the same ones.
  const identity = {
    workspace: context.ids.next(NOTION_IDS.uuid),
    bot: context.ids.next(NOTION_IDS.uuid),
    integration: context.ids.next(NOTION_IDS.uuid),
    subscription: context.ids.next(NOTION_IDS.uuid),
    owner: context.ids.next(NOTION_IDS.uuid),
  };
  const fake = {
    api: createNotionApi(context, world),
    world,
    store,
    seed() {
      store.seed(
        { id: identity.workspace, name: "Acme" },
        {
          id: identity.bot,
          integrationId: identity.integration,
          subscriptionId: identity.subscription,
          name: DEFAULT_INTEGRATION.name,
          events: DEFAULT_INTEGRATION.events,
          capabilities: DEFAULT_INTEGRATION.capabilities,
        },
        { id: identity.owner, name: "Workspace owner", email: "owner@acme.example", avatarUrl: null, fixedId: false },
      );
    },
    release(session: string) {
      world.forgetSession(session);
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of store.users.list(session)) if (user.fixedId) context.ids.release(NOTION_IDS.uuid, user.id);
    },
  } satisfies NotionFake;
  fake.seed();
  return fake;
}
