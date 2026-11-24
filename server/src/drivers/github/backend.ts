import type { DeliveryAttempt, DeliveryRecord } from "../../core/delivery/index.ts";
import type { GitHubIssueChanges, GitHubIssueInput } from "./fake/issues.ts";
import type { GitHubRepoInput, GitHubUserInput } from "./fake/repos.ts";
import type { GitHubStore } from "./fake/store.ts";
import type {
  GitHubCommentRecord,
  GitHubIssueRecord,
  GitHubReactionContent,
  GitHubRepoRecord,
  GitHubUserRecord,
} from "./world.ts";

/** A value now (the fake), or once GitHub answered (live). */
type Awaitable<T> = T | Promise<T>;

/** A delivery as the routes show it: the fake's own, or one of the App's delivery log on GitHub. */
export type GitHubDeliveryView = Pick<DeliveryRecord, "attempts"> & {
  request: Pick<DeliveryRecord["request"], "id" | "type" | "meta">;
};

/**
 * What people do on GitHub that works live, written once. The fake implements it over its world
 * (bringing GitHub's permission checks, which real GitHub makes itself); the live world against
 * real GitHub, keeping what it read and made in a store of its own, so the routes read records the
 * same way from both (architecture.md 3.3). Pull requests, reviews, pushes and checks aren't live
 * yet: their routes use the fake's parts directly, and the router refuses them live.
 */
export interface GitHubWorld {
  /** The records the routes read: the fake's own, or the live world's mirror of real GitHub. */
  readonly store: GitHubStore;
  /** Where a person opens a repository. */
  repoWeb(repo: GitHubRepoRecord): string;

  createUser(session: string, input: GitHubUserInput & { token?: string | undefined }): Awaitable<GitHubUserRecord>;
  createRepo(session: string, input: GitHubRepoInput): Awaitable<GitHubRepoRecord>;
  readFile(repo: GitHubRepoRecord, path: string, ref?: string): Awaitable<Uint8Array | undefined>;

  openIssue(repo: GitHubRepoRecord, actor: number, input: GitHubIssueInput): Awaitable<GitHubIssueRecord>;
  updateIssue(issue: GitHubIssueRecord, actor: number, changes: GitHubIssueChanges): Awaitable<string | undefined>;
  label(
    issue: GitHubIssueRecord,
    actor: number,
    labels: readonly string[],
    add: boolean,
  ): Awaitable<Array<string | undefined>>;
  assign(issue: GitHubIssueRecord, actor: number, assignees: readonly number[]): Awaitable<Array<string | undefined>>;
  comment(issue: GitHubIssueRecord, actor: number, body: string): Awaitable<GitHubCommentRecord>;
  editComment(comment: GitHubCommentRecord, actor: number, body: string): Awaitable<string | undefined>;
  deleteComment(comment: GitHubCommentRecord, actor: number): Awaitable<string | undefined>;
  react(
    target: GitHubIssueRecord | GitHubCommentRecord,
    actor: number,
    content: GitHubReactionContent,
  ): Awaitable<void>;
  /** Read an issue again with its comments. The fake holds the truth already; live, this asks GitHub. */
  refresh(session: string, issue: GitHubIssueRecord): Awaitable<void>;

  /** The deliveries to the agent about this session's repositories, oldest first. */
  deliveries(session: string): Awaitable<GitHubDeliveryView[]>;
  delivery(session: string, guid: string): Awaitable<GitHubDeliveryView>;
  /** Redeliver from the App's delivery log: the same GUID, a new attempt. */
  redeliver(session: string, guid: string): Awaitable<DeliveryAttempt>;
}
