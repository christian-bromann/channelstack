import type { LinearStore } from "./fake/store.ts";
import type { LinearLinks } from "./links.ts";
import type {
  LinearCommentRecord,
  LinearIssueChanges,
  LinearIssueInput,
  LinearIssueRecord,
  LinearSessionRecord,
  LinearStateRecord,
  LinearStateType,
  LinearTeamRecord,
  LinearUserRecord,
} from "./world.ts";

/** A value now (the fake), or once Linear answered (live). */
type Awaitable<T> = T | Promise<T>;

/**
 * Every control action on Linear, written once. The fake implements it over its store; the live
 * world against real Linear, keeping what it read and made in a store of its own, so the routes
 * read records the same way from both (architecture.md 3.3). A delivery comes back only from the
 * fake: live, Linear delivers to the agent itself.
 */
export interface LinearWorld {
  /** The records the routes read: the fake's own, or the live world's mirror of real Linear. */
  readonly store: LinearStore;
  readonly links: LinearLinks;
  markdown(session: string, text: string): string;
  readable(body: string): string;
  rootOf(comment: LinearCommentRecord): LinearCommentRecord;
  stateOf(issue: LinearIssueRecord): LinearStateRecord;

  createUser(
    session: string,
    input: {
      name: string;
      id?: string | undefined;
      displayName?: string | undefined;
      email?: string | undefined;
      admin?: boolean | undefined;
      guest?: boolean | undefined;
      token?: string | undefined;
    },
  ): Awaitable<LinearUserRecord>;
  createTeam(
    session: string,
    input: {
      key?: string | undefined;
      name?: string | undefined;
      members: readonly string[];
      states?: ReadonlyArray<{ name: string; type: LinearStateType }> | undefined;
      labels?: readonly string[] | undefined;
    },
  ): Awaitable<LinearTeamRecord>;
  createIssue(team: LinearTeamRecord, creator: string, input: LinearIssueInput): Awaitable<LinearIssueRecord>;
  updateIssue(issue: LinearIssueRecord, actor: string, changes: LinearIssueChanges): Awaitable<string | undefined>;
  comment(
    issue: LinearIssueRecord,
    user: string,
    body: string,
    parent?: LinearCommentRecord,
  ): Awaitable<LinearCommentRecord>;
  editComment(record: LinearCommentRecord, actor: string, body: string): Awaitable<string | undefined>;
  deleteComment(record: LinearCommentRecord, actor: string): Awaitable<string | undefined>;
  react(record: LinearCommentRecord, user: string, emoji: string): Awaitable<void>;
  /** A person's turn in a session that has no thread to reply in yet. */
  promptSession(record: LinearSessionRecord, user: string, body: string): Awaitable<string | undefined>;
  /**
   * Read again what a read is about: an issue with its comments, sessions and their activities, or
   * one session. The fake holds the truth already; live, this asks Linear.
   */
  refresh(session: string, about: { issue: string } | { agentSession: string }): Awaitable<void>;
}
