import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { createLinearApi } from "./api.ts";
import { LinearStore } from "./store.ts";
import { createFakeWorld, type FakeLinearWorld } from "./world.ts";

/** The agent's app, until `channelstack.config.ts` describes it: an agent subscribed to its sessions, issues and comments. */
const DEFAULT_APP = { name: "my-agent", events: ["AgentSessionEvent", "Issue", "Comment"] } as const;

export interface LinearFake extends FakeBackend {
  readonly world: FakeLinearWorld;
  readonly store: LinearStore;
}

/** The Linear fake: the GraphQL API over an in-memory workspace, wired to core's ids, event log and delivery queue. */
export function createLinearFake(context: DriverContext): LinearFake {
  const store = new LinearStore(context.registry);
  const world = createFakeWorld(context, store);
  // Who the workspace and the app are is drawn once: the agent holds the app's ids from
  // `channelstack env`, and a reset builds a new world with the same app in it.
  const identity = { org: context.ids.next("linear.uuid"), appUser: context.ids.next("linear.uuid") };
  const fake = {
    api: createLinearApi(context, world),
    world,
    store,
    seed() {
      const now = context.clock();
      store.seed(
        { id: identity.org, name: "Acme", urlKey: "acme" },
        { userId: identity.appUser, name: DEFAULT_APP.name, events: DEFAULT_APP.events, createdAt: now },
        {
          id: identity.appUser,
          name: DEFAULT_APP.name,
          displayName: DEFAULT_APP.name,
          email: `${DEFAULT_APP.name}@oauthapp.linear.app`,
          admin: false,
          guest: false,
          app: true,
          fixedId: false,
          createdAt: now,
        },
      );
    },
    release(session: string) {
      const released = store.release(session);
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of released.users) if (user.fixedId) context.ids.release("linear.uuid", user.id);
    },
  } satisfies LinearFake;
  fake.seed();
  return fake;
}
