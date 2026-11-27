/**
 * A Discord bot on discord.js, written the way its guide shows: a `Client` with the intents it
 * needs, `messageCreate` answered with `message.reply`, slash commands registered for the guild,
 * and interactions taken at an HTTP endpoint, checked with `discord-interactions`'s `verifyKey`. It
 * is configured from the environment `channelstack env` prints and talks to whatever
 * `DISCORD_API_URL` points at: the fake in tests, Discord itself when the variable is unset. It has
 * no channelstack code in it.
 */
import { startDiscordAgent } from "../shared/discord.ts";

const {
  DISCORD_TOKEN,
  DISCORD_API_URL,
  DISCORD_APPLICATION_ID,
  DISCORD_PUBLIC_KEY,
  DISCORD_GUILD_ID,
  DISCORD_PEOPLE_BOTS,
  PORT,
} = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !DISCORD_PUBLIC_KEY || !DISCORD_GUILD_ID || !PORT) {
  throw new Error(
    "The agent needs DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID and PORT",
  );
}

await startDiscordAgent({
  token: DISCORD_TOKEN,
  apiUrl: DISCORD_API_URL,
  applicationId: DISCORD_APPLICATION_ID,
  publicKey: DISCORD_PUBLIC_KEY,
  guildId: DISCORD_GUILD_ID,
  port: Number(PORT),
  // Bot ids, comma-separated, that are people here: set by a live run, whose people are bots.
  people: DISCORD_PEOPLE_BOTS?.split(",").filter((id) => id !== ""),
});
