import { Hono } from "hono";

import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { SlackStore } from "./store.ts";
import { createFakeWorld, type FakeSlackWorld } from "./world.ts";

/**
 * The agent's app, until `channelstack.config.ts` describes it: a bot with the scopes and event
 * subscriptions a conversational agent usually has.
 */
const DEFAULT_APP = {
  name: "my-agent",
  scopes: [
    "app_mentions:read",
    "channels:history",
    "channels:join",
    "channels:read",
    "chat:write",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "reactions:read",
    "reactions:write",
    "users:read",
    "assistant:write",
  ],
  botEvents: [
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
    "message.mpim",
    "reaction_added",
    "reaction_removed",
    "member_joined_channel",
    "member_left_channel",
    "app_uninstalled",
    "tokens_revoked",
  ],
};

export interface SlackFake extends FakeBackend {
  readonly world: FakeSlackWorld;
  readonly store: SlackStore;
}

/** The Slack fake: the Web API over an in-memory store, wired to core's ids, event log and delivery queue. */
export function createSlackFake(context: DriverContext): SlackFake {
  const store = new SlackStore(context.registry);
  const world = createFakeWorld(context, store);
  const fake = {
    api: new Hono(),
    world,
    store,
    seed() {
      store.seed(
        { id: context.ids.next("slack.team"), name: "Acme", domain: "acme" },
        {
          id: context.ids.next("slack.app"),
          name: DEFAULT_APP.name,
          botId: context.ids.next("slack.bot"),
          botUserId: context.ids.next("slack.user"),
          scopes: DEFAULT_APP.scopes,
          botEvents: DEFAULT_APP.botEvents,
          installed: true,
        },
      );
    },
    release(session: string) {
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of store.release(session)) if (user.fixedId) context.ids.release("slack.user", user.id);
    },
  } satisfies SlackFake;
  fake.seed();
  return fake;
}
