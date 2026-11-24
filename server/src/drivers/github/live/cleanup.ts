import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { GitHubRefusal } from "../fake/kit.ts";
import type { GitHubCaller, GitHubLiveClient } from "./client.ts";

/**
 * Remove one thing the ledger lists: a session's repository, deleted with everything in it
 * (issues, comments, branches). An org owner can restore a deleted repository for 90 days.
 */
export async function removeGitHubEntry(
  client: GitHubLiveClient,
  installation: GitHubCaller,
  entry: LedgerEntry,
): Promise<void> {
  if (entry.kind !== "repo") throw new Error(`channelstack doesn't know how to remove a GitHub ${entry.kind}`);
  const [owner, repo] = String(entry.ref.repo).split("/");
  try {
    await client.call(installation, "DELETE /repos/{owner}/{repo}", { owner, repo });
  } catch (error) {
    // Gone already: nothing is left to remove.
    if (!(error instanceof GitHubRefusal && error.githubStatus === 404)) throw error;
  }
}
