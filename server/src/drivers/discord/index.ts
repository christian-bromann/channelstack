import { BUILT_IN_APP } from "../../core/apps/index.ts";
import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { discordDev } from "./dev.ts";
import { createDiscordFake } from "./fake/index.ts";
import { DISCORD_IDS } from "./ids.ts";
import { removeDiscordEntry } from "./live/cleanup.ts";
import { DiscordRestClient } from "./live/client.ts";
import { discordMaintenance } from "./live/maintenance.ts";
import { createLiveDiscordWorld } from "./live/world.ts";
import { registerDiscordRoutes } from "./routes.ts";
import { DISCORD_SECRETS } from "./secrets.ts";
import { publicKeyOf } from "./signing.ts";

/** The Discord driver: REST v10, the Gateway and interactions, and a guild's people. */
export const discord: DriverDefinition = {
  name: "discord",
  title: "Discord",
  dev: discordDev,
  ids: DISCORD_IDS,
  // A bot token (`<id in base 64>.<6>.<38>`) and an interaction's token, wherever they turn up.
  tokenPatterns: [
    /[MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{38}/g,
    /aW50ZXJhY3Rpb246[A-Za-z0-9_-]{20,}/g,
  ],
  liveTokens: [DISCORD_SECRETS.liveBotToken, DISCORD_SECRETS.interactionToken],
  hosts: ["discord.com", "gateway.discord.gg"],
  secrets: {
    botToken: DISCORD_SECRETS.botToken,
    interactionsKey: DISCORD_SECRETS.interactionsKey,
  },
  // The agent's real bot in a test guild (live-mode.md, section 4). A person is a second application's bot there.
  live: {
    credentials: ["CHANNELSTACK_DISCORD_BOT_TOKEN"],
    allowlist: "CHANNELSTACK_LIVE_DISCORD_GUILDS",
    maintenance: discordMaintenance,
  },
  create(context): Driver {
    const fake = createDiscordFake(context);
    /** An app's public key: the other half of its own signing key. */
    const publicKey = (app = BUILT_IN_APP) => publicKeyOf(context.apps.secret(app, "interactionsKey"));
    const client = new DiscordRestClient({
      base: context.live.apiBase,
      fetch: context.live.fetch,
      timers: context.timers,
    });
    const live = context.live.active
      ? createLiveDiscordWorld({
          client,
          live: context.live,
          clock: context.clock,
          appName: fake.store.app.name,
        })
      : undefined;
    if (live) {
      const bot = context.live.vault.fromEnv("CHANNELSTACK_DISCORD_BOT_TOKEN");
      context.live.ledger.onCleanup("discord", async (entry) => {
        if (bot) await removeDiscordEntry(client, bot, entry);
      });
    }
    return {
      name: "discord",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerDiscordRoutes(router, {
          fake: fake.world,
          live,
          reality: () => (live ? "live" : "fake"),
          events: context.events,
          apiUrl: context.apiUrl,
          secret: (name, app) => context.apps.secret(app ?? BUILT_IN_APP, name),
          publicKey,
        }),
      capabilities: () => ({}),
      openWork: (session) => fake.world.openWork(session),
      // What the agent needs: discord.js's `rest.api`, its token, and what it registers commands in and checks interactions with.
      // Live, `channelstack env` prints nothing for Discord (app.ts): the agent talks to it with its own configuration.
      env: (name) => {
        // Another app's lines have the built-in app's keys, so its agent starts from an .env of the same shape.
        const app = fake.store.apps.forEnv(name, (wanted) => fake.world.createApp(undefined, { name: wanted }));
        return {
          DISCORD_API_URL: `${context.apiUrl()}/api`,
          DISCORD_TOKEN: context.apps.secret(app.name, "botToken"),
          DISCORD_APPLICATION_ID: app.id,
          DISCORD_PUBLIC_KEY: publicKey(app.name),
          DISCORD_GUILD_ID: fake.store.guild.id,
        };
      },
    };
  },
};
