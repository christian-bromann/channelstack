import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { SLACK_IDS } from "../ids.ts";
import { createSlackApi } from "./api.ts";
import { createSocketModes } from "./socket.ts";
import { SlackStore } from "./store.ts";
import { createFakeWorld, type FakeSlackWorld } from "./world.ts";

/**
 * The agent's app, built in (there is no config file): a bot with the scopes and event
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
    "files:read",
    "files:write",
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
    "agent_session_stopped",
    "assistant_thread_started",
    "assistant_thread_context_changed",
  ],
};

export interface SlackFake extends FakeBackend {
  readonly world: FakeSlackWorld;
  readonly store: SlackStore;
}

/** The Slack fake: the Web API over an in-memory store, wired to core's ids, event log and delivery queue. */
export function createSlackFake(context: DriverContext): SlackFake {
  const store = new SlackStore(context.registry);
  const socket = createSocketModes(context);
  const world = createFakeWorld(context, store, socket, DEFAULT_APP);
  const fake = {
    api: createSlackApi(context, store, world, socket),
    socket: socket.accept,
    world,
    store,
    seed() {
      store.seed(
        { id: context.ids.next(SLACK_IDS.team), name: "Acme", domain: "acme" },
        {
          id: context.ids.next(SLACK_IDS.app),
          name: DEFAULT_APP.name,
          botId: context.ids.next(SLACK_IDS.bot),
          botUserId: context.ids.next(SLACK_IDS.user),
          scopes: DEFAULT_APP.scopes,
          botEvents: DEFAULT_APP.botEvents,
          installed: true,
          updated: Math.floor(context.clock() / 1000),
        },
      );
    },
    release(session: string) {
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of store.release(session)) if (user.fixedId) context.ids.release(SLACK_IDS.user, user.id);
    },
  } satisfies SlackFake;
  fake.seed();
  return fake;
}
