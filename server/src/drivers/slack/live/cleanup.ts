import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { taggedRun } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { SlackRefusal } from "../world.ts";
import type { SlackWebClient } from "./client.ts";

/** Whose credentials cleanup can use: by the ledger's owner name (`app`, `user:ANA`), and by the Slack user who wrote a message. */
export interface SlackCredentials {
  byOwner(owner: string): LiveCredential | undefined;
  byUser(userId: string): LiveCredential | undefined;
}

/** Slack answers that mean the object is gone already: cleanup is done. */
const GONE = new Set(["already_archived", "channel_not_found", "message_not_found", "is_archived"]);

const gone = (error: unknown) => error instanceof SlackRefusal && GONE.has(error.code);

interface Written {
  ts: string;
  user?: string;
  reply_count?: number;
}

/**
 * Remove one thing the ledger lists. A channel is archived: Slack has no way to delete one outside
 * Enterprise Grid, and an archived channel is out of everyone's way. A DM can't be archived, so
 * everything written there since the session's first message is deleted, by whoever wrote it.
 */
export async function removeSlackEntry(
  client: SlackWebClient,
  credentials: SlackCredentials,
  entry: LedgerEntry,
): Promise<void> {
  const channel = entry.ref.channel ?? "";
  const by = credentials.byOwner(entry.by);
  if (!by) throw new Error(`No credential for ${entry.by} to remove ${entry.kind} ${channel}`);
  if (entry.kind === "channel") {
    try {
      await client.call("conversations.archive", by, { channel });
    } catch (error) {
      if (!gone(error)) throw error;
    }
    return;
  }
  if (entry.kind === "conversation") {
    const top = await client.all<Written>("conversations.history", by, "messages", {
      channel,
      oldest: entry.ref.oldest,
      inclusive: true,
    });
    const replies = await Promise.all(
      top
        .filter((message) => (message.reply_count ?? 0) > 0)
        .map((message) => client.all<Written>("conversations.replies", by, "messages", { channel, ts: message.ts })),
    );
    const written = new Map<string, Written>();
    for (const message of [...top, ...replies.flat()]) written.set(message.ts, message);
    // Replies before the messages they hang on, newest first.
    for (const message of [...written.values()].sort((a, b) => b.ts.localeCompare(a.ts))) {
      const author = message.user === undefined ? undefined : credentials.byUser(message.user);
      // Someone else's message (a person outside the test) stays.
      if (!author) continue;
      try {
        await client.call("chat.delete", author, { channel, ts: message.ts });
      } catch (error) {
        if (!gone(error)) throw error;
      }
    }
    return;
  }
  throw new Error(`channelstack doesn't know how to remove a Slack ${entry.kind}`);
}

interface ListedChannel {
  id: string;
  name: string;
  created: number;
  is_member?: boolean;
  is_archived?: boolean;
}

/** A channel some run tagged and nobody archived. */
export interface TaggedChannel {
  id: string;
  name: string;
  run: string;
  created: number;
}

/**
 * The tagged channels still open in the workspace: every channel whose name carries a run's tag,
 * as each credential sees them (a private one only its members see). `run` narrows it to one run.
 */
export async function taggedChannels(
  client: SlackWebClient,
  credentials: readonly LiveCredential[],
  run?: string,
): Promise<Array<TaggedChannel & { members: LiveCredential[] }>> {
  const found = new Map<string, TaggedChannel & { members: LiveCredential[] }>();
  for (const credential of credentials) {
    const channels = await client.all<ListedChannel>("conversations.list", credential, "channels", {
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    for (const channel of channels) {
      const tagged = taggedRun(channel.name);
      if (tagged === undefined || (run !== undefined && tagged !== run) || channel.is_archived) continue;
      const entry = found.get(channel.id) ?? { id: channel.id, name: channel.name, run: tagged, created: channel.created, members: [] };
      if (channel.is_member) entry.members.push(credential);
      found.set(channel.id, entry);
    }
  }
  return [...found.values()];
}

/** Archive a tagged channel with a credential that is in it. */
export async function archiveTagged(client: SlackWebClient, channel: { id: string; members: LiveCredential[] }): Promise<boolean> {
  for (const member of channel.members) {
    try {
      await client.call("conversations.archive", member, { channel: channel.id });
      return true;
    } catch (error) {
      if (gone(error)) return true;
    }
  }
  return false;
}
