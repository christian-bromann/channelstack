import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { LiveVault } from "../../../core/secrets/index.ts";
import { removeDiscordEntry, taggedChannels } from "./cleanup.ts";
import { DiscordRestClient } from "./client.ts";
import { checkDiscordCredential, identifyDiscord } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_DISCORD_GUILDS";

/** The agent's bot token and each person's in the environment, with who each is in Discord (or why Discord refused it). */
const identities = (client: DiscordRestClient, env: Readonly<Record<string, string | undefined>>) =>
  liveCredentials(env, {
    channel: "discord",
    own: [{ variable: "CHANNELSTACK_DISCORD_BOT_TOKEN", owner: "app" }],
    identify: (credential) => identifyDiscord(client, credential, credential.owner === "app" ? {} : { role: "person" }),
  });

/** `channelstack doctor` and `sweep` for Discord, from the bot's token in the environment. */
export const discordMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, timers, apiBase }) {
    const client = new DiscordRestClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await identities(client, env);
    // A person's bot is checked against the agent's, as a live run's createUser checks it.
    const agent = found.find((entry) => entry.credential.owner === "app")?.who;
    const agentGuild = (() => {
      try {
        return agent && checkDiscordCredential(agent, { who: "CHANNELSTACK_DISCORD_BOT_TOKEN", allowlist });
      } catch {
        // The agent's own line says why.
        return undefined;
      }
    })();
    const app = agent && agentGuild && { botUserId: agent.botUserId, guildId: agentGuild.id };
    return credentialChecks(found, ({ variable, credential, who }) => {
      const role = credential.owner === "app" ? "app" : "person";
      const guild = checkDiscordCredential(who, { who: variable, allowlist, role, app });
      if (role === "person") return `a person's bot ${who.name} in guild ${guild.id}`;
      const intents = who.privilegedIntents.length === 0 ? "no privileged intents" : who.privilegedIntents.join(", ");
      return `the app's bot ${who.name} in guild ${guild.id} (${intents})`;
    });
  },

  async sweep({ env, fetch, timers, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new DiscordRestClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const bot = new LiveVault(env, () => {}).fromEnv("CHANNELSTACK_DISCORD_BOT_TOKEN");
    if (!bot) return { removed: [], left: [], done: [] };
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `${entry.kind} #${entry.ref.name ?? entry.ref.channel ?? ""}`,
      remove: (entry) => removeDiscordEntry(client, bot, entry),
    });
    const who = await identifyDiscord(client, bot);
    const guilds = who.guilds.filter((guild) => allowlist.allows(guild.id));
    const channels = (await Promise.all(guilds.map((guild) => taggedChannels(client, bot, guild.id, run)))).flat();
    return sweepTagged(report, channels, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (channel) => `channel #${channel.name}`,
      known: (channel, entry) => entry.channel === "discord" && entry.ref.channel === channel.id,
      createdAt: (channel) => channel.createdAt,
      remove: async (channel) => {
        await client.call(bot, "DELETE", `/channels/${channel.id}`);
        return undefined;
      },
    });
  },
};
