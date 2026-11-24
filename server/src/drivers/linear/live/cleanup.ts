import type { LedgerEntry } from "../../../core/ledger/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { type LinearGraphqlClient, LinearRefusal } from "./client.ts";

/**
 * Remove one thing the ledger lists. A team is deleted, and its issues, comments and agent
 * sessions with it: Linear deletes a team with everything in it (it can be restored for a while
 * from the workspace's settings).
 */
export async function removeLinearEntry(
  client: LinearGraphqlClient,
  byOwner: (owner: string) => LiveCredential | undefined,
  entry: LedgerEntry,
): Promise<void> {
  const by = byOwner(entry.by);
  if (!by) throw new Error(`No credential for ${entry.by} to remove ${entry.kind} ${entry.ref.name ?? ""}`);
  if (entry.kind !== "team") throw new Error(`channelstack doesn't know how to remove a Linear ${entry.kind}`);
  try {
    await client.call(
      by,
      /* GraphQL */ `
        mutation TeamDelete($id: String!) {
          teamDelete(id: $id) {
            success
          }
        }
      `,
      {
        id: entry.ref.team,
      },
    );
  } catch (error) {
    // Gone already: nothing is left to remove.
    if (!(error instanceof LinearRefusal && /not found|entity not found/i.test(error.message))) throw error;
  }
}
