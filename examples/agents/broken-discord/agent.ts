/**
 * A Discord bot with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=discord.resume` (any check id) it has exactly the bug that check
 * exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import { startDiscordAgent } from "../shared/discord.ts";

const { DISCORD_TOKEN, DISCORD_API_URL, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID, PORT } =
  process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !DISCORD_PUBLIC_KEY || !DISCORD_GUILD_ID || !PORT) {
  throw new Error(
    "The agent needs DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, DISCORD_GUILD_ID and PORT",
  );
}
const fault = process.env.BROKEN ?? "";

await startDiscordAgent({
  token: DISCORD_TOKEN,
  apiUrl: DISCORD_API_URL,
  applicationId: DISCORD_APPLICATION_ID,
  publicKey: DISCORD_PUBLIC_KEY,
  guildId: DISCORD_GUILD_ID,
  port: Number(PORT),
  faulty: (check) => fault === check,
});
