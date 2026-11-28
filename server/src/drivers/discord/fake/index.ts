import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { DISCORD_IDS } from "../ids.ts";
import { applicationFlags, guildObject, JOINED_AT, memberObject, userObject } from "../payloads.ts";
import { has } from "../permissions.ts";
import { botIdOf } from "../secrets.ts";
import { createDiscordApi } from "./api.ts";
import { createGateways } from "./gateway.ts";
import { DiscordStore } from "./store.ts";
import { createFakeWorld, type FakeDiscordWorld } from "./world.ts";

/**
 * The agent's app, built in (there is no config file): a bot named `my-agent` in a guild named
 * Acme, with the privileged intents a conversational bot switches on in the developer portal.
 */
const DEFAULT_APP = {
  name: "my-agent",
  guild: "Acme",
  privilegedIntents: ["GUILD_MEMBERS", "MESSAGE_CONTENT"],
} as const;

export interface DiscordFake extends FakeBackend {
  readonly world: FakeDiscordWorld;
  readonly store: DiscordStore;
}

/** The Discord fake: REST v10 and the Gateway over an in-memory guild, wired to core. */
export function createDiscordFake(context: DriverContext): DiscordFake {
  const store = new DiscordStore(context.registry);
  // Who the guild and the app are is drawn once: the agent holds them from `channelstack env`, and a reset keeps them.
  const identity = {
    guild: context.ids.next(DISCORD_IDS.guild),
    owner: context.ids.next(DISCORD_IDS.user),
    role: context.ids.next(DISCORD_IDS.role),
    admin: context.ids.next(DISCORD_IDS.role),
  };
  // The bot's id is in its token, as in Discord's: the token is the install's, so the bot is too.
  const botId = () => botIdOf(context.secret("botToken")) ?? identity.owner;

  let world: FakeDiscordWorld;
  /** An app by name: the Gateway knows bots by their app's name. */
  const named = (app: string) => store.apps.named(app) ?? store.app;
  const gateway = createGateways(context, {
    appWithToken: (token) => store.apps.withSecret(token, (app) => context.apps.secret(app, "botToken"))?.name,
    privilegedIntents: (app) => named(app).privilegedIntents,
    takeDrop: (session) => {
      const at = store.faults.findIndex((fault) => fault.type === "drop_gateway" && fault.session === session);
      if (at < 0) return false;
      store.faults.splice(at, 1);
      return true;
    },
    ready: (name, session, resumeUrl) => {
      const app = named(name);
      return {
        v: 10,
        user_settings: {},
        user: { ...userObject({ kind: "app", app }), verified: true, mfa_enabled: false, email: null },
        guilds: [{ id: store.guild.id, unavailable: true }],
        guild_join_requests: [],
        presences: [],
        private_channels: [],
        relationships: [],
        session_id: session,
        session_type: "normal",
        resume_gateway_url: resumeUrl,
        shard: [0, 1],
        application: {
          id: app.id,
          flags: applicationFlags(app.privilegedIntents),
          // The same flags as a string, for flags past 2^53, as Discord's READY carries them.
          flags_new: String(applicationFlags(app.privilegedIntents)),
        },
        auth: {},
        geo_ordered_rtc_regions: [],
        _trace: ['["gateway-prd-channelstack",{"micros":0}]'],
      };
    },
    afterReady: (name) => {
      const app = named(name);
      const visible = store.allChannels().filter((channel) => has(world.botPermissions(channel, app), "VIEW_CHANNEL"));
      return [
        {
          t: "GUILD_CREATE",
          d: {
            ...guildObject(store.guild, world.guildRoles()),
            joined_at: new Date(JOINED_AT).toISOString(),
            large: false,
            unavailable: false,
            member_count: store.users.values().length + store.apps.all().length + 1,
            members: [{ ...memberObject([app.roleId], JOINED_AT), user: userObject({ kind: "app", app }) }],
            channels: visible
              .filter((channel) => channel.kind === "text")
              .map((channel) => world.channelWire(channel, app)),
            threads: visible
              .filter((channel) => channel.kind === "public_thread")
              .map((channel) => world.channelWire(channel, app)),
            presences: [],
            voice_states: [],
            stage_instances: [],
            guild_scheduled_events: [],
            soundboard_sounds: [],
            embedded_activities: [],
            activity_instances: [],
            lazy: true,
            application_command_counts: {},
          },
        },
      ];
    },
  });
  world = createFakeWorld(context, store, gateway, DEFAULT_APP);

  const fake = {
    api: createDiscordApi(context, world, gateway),
    socket: gateway.accept,
    world,
    store,
    seed() {
      const id = botId();
      store.seed(
        { id: identity.guild, name: DEFAULT_APP.guild, ownerId: identity.owner },
        {
          id,
          name: DEFAULT_APP.name,
          botUserId: id,
          roleId: identity.role,
          privilegedIntents: DEFAULT_APP.privilegedIntents,
        },
        identity.admin,
      );
      gateway.reset();
    },
    release(session: string) {
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of store.release(session)) if (user.fixedId) context.ids.release(DISCORD_IDS.user, user.id);
    },
  } satisfies DiscordFake;
  fake.seed();
  return fake;
}
