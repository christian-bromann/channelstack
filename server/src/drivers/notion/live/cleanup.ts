import type { LedgerEntry } from "../../../core/ledger/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { NotionRefusal, type NotionRestClient } from "./client.ts";

/** Codes for a page that is gone already, or in the trash: nothing is left to remove. */
const GONE = new Set(["object_not_found"]);

/**
 * Remove one thing the ledger lists: a session's page, which goes to the trash with everything
 * under it (its pages, blocks and discussions). Notion empties its trash after 30 days.
 */
export async function removeNotionEntry(
  client: NotionRestClient,
  byOwner: (owner: string) => LiveCredential | undefined,
  entry: LedgerEntry,
): Promise<void> {
  const by = byOwner(entry.by);
  if (!by) throw new Error(`No credential for ${entry.by} to remove ${entry.kind} ${entry.ref.name ?? ""}`);
  if (entry.kind !== "page") throw new Error(`channelstack doesn't know how to remove a Notion ${entry.kind}`);
  try {
    await client.call(by, "patch", `pages/${entry.ref.page}`, { body: { in_trash: true } });
  } catch (error) {
    if (!(error instanceof NotionRefusal && (GONE.has(error.code) || /archived|in trash/i.test(error.message))))
      throw error;
  }
}
