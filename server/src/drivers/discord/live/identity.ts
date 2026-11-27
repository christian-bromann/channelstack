import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { DiscordRestClient } from "./client.ts";

/** Who a bot token is: the bot, its application, the guilds it is in, its privileged intents. */
export interface DiscordIdentity {
  readonly botUserId: string;
  readonly applicationId: string;
  readonly name: string;
  readonly guilds: ReadonlyArray<{ id: string; name: string }>;
  readonly privilegedIntents: readonly string[];
}

/** An application's flags for the privileged intents switched on in the developer portal (verified, or not). */
const INTENT_FLAGS: ReadonlyArray<readonly [string, number]> = [
  ["GUILD_PRESENCES", (1 << 12) | (1 << 13)],
  ["GUILD_MEMBERS", (1 << 14) | (1 << 15)],
  ["MESSAGE_CONTENT", (1 << 18) | (1 << 19)],
];

/** Who a bot token is. `who` names it in a refusal; a person's (`role: "person"`) is a second application's bot. */
export async function identifyDiscord(
  client: DiscordRestClient,
  token: LiveCredential,
  options: { who?: string; role?: "app" | "person" } = {},
): Promise<DiscordIdentity> {
  const me = await client.call<{ id: string; username: string; bot?: boolean }>(token, "GET", "/users/@me");
  if (!me.bot) {
    throw liveMisconfigured(
      `${options.who ?? "The token"} isn't a bot's`,
      options.role === "person"
        ? "give the person the bot token of a second application, in the same guild"
        : "use the application's bot token",
    );
  }
  const application = await client.call<{ id: string; flags?: number }>(token, "GET", "/oauth2/applications/@me");
  const guilds = await client.call<Array<{ id: string; name: string }>>(token, "GET", "/users/@me/guilds");
  const flags = application.flags ?? 0;
  return {
    botUserId: me.id,
    applicationId: application.id,
    name: me.username,
    guilds: guilds.map(({ id, name }) => ({ id, name })),
    privilegedIntents: INTENT_FLAGS.filter(([, bits]) => (flags & bits) !== 0).map(([name]) => name),
  };
}

/**
 * The one check of a bot token, for a live run and for `doctor`. The agent's bot (`app`) is in a
 * guild of the allowlist, and that guild is where the run acts. A person's (`person`, a second
 * application's bot, decision 0026) isn't the agent's own bot, and is in the agent's guild. Answers
 * the guild.
 */
export function checkDiscordCredential(
  identity: DiscordIdentity,
  options: {
    who: string;
    allowlist: Allowlist;
    role?: "app" | "person";
    /** For a person: the agent's bot and its guild, when known. */
    app?: { botUserId: string; guildId: string } | undefined;
  },
): { id: string; name: string } {
  const { app } = options;
  if (options.role === "person" && app) {
    if (identity.botUserId === app.botUserId) {
      throw liveMisconfigured(
        `${options.who} is the agent's own bot`,
        "give the person the bot token of a second application, in the same guild",
      );
    }
    const guild = identity.guilds.find((each) => each.id === app.guildId);
    if (!guild) {
      throw liveMisconfigured(
        `${options.who}'s bot isn't in the sandbox guild (${app.guildId})`,
        "add their application's bot to the guild",
      );
    }
    return guild;
  }
  const [first] = identity.guilds;
  if (!first) throw liveMisconfigured(`${options.who}'s bot is in no guild`, "add it to the sandbox guild");
  const allowed = identity.guilds.find((guild) => options.allowlist.allows(guild.id));
  if (!allowed) options.allowlist.assert(first.id, `guild ${first.id}`);
  return allowed ?? first;
}
