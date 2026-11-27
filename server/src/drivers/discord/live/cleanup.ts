import { ProtocolError } from "../../../core/errors/index.ts";
import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { taggedRun } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { snowflakeTime } from "../ids.ts";
import type { DiscordRestClient } from "./client.ts";

/**
 * Remove what a live session made: a channel, which takes its messages and threads with it. One
 * Discord says is gone already counts as removed.
 */
export async function removeDiscordEntry(
  client: DiscordRestClient,
  bot: LiveCredential,
  entry: LedgerEntry,
): Promise<void> {
  if (entry.kind !== "channel" || entry.ref.channel === undefined) return;
  try {
    await client.call(bot, "DELETE", `/channels/${entry.ref.channel}`);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "unknown_channel") return;
    throw error;
  }
}

/** The guild's channels a run tagged, as the bot sees them, with when each was made. */
export async function taggedChannels(
  client: DiscordRestClient,
  bot: LiveCredential,
  guild: string,
  run: string | undefined,
): Promise<Array<{ id: string; name: string; createdAt: number }>> {
  const all = await client.call<Array<{ id: string; name?: string; type: number }>>(
    bot,
    "GET",
    `/guilds/${guild}/channels`,
  );
  return all
    .filter((channel) => channel.type === 0 && channel.name !== undefined)
    .filter((channel) => {
      const tagged = taggedRun(channel.name ?? "");
      return tagged !== undefined && (run === undefined || tagged === run);
    })
    .map((channel) => ({ id: channel.id, name: channel.name ?? "", createdAt: Date.parse(snowflakeTime(channel.id)) }));
}
