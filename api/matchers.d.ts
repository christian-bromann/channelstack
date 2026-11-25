import type { AuthorRef, Delivery, Duration, Principal, QuietOptions, WaitOptions } from "./common";
import type { SlackUser } from "./slack";

/**
 * Channel matchers added to the test framework's `expect`.
 *
 * - All matchers are async: `await expect(thread).toHaveRepliesFrom("my-agent", { count: 1 })`.
 * - Positive matchers resolve as soon as the condition holds, or fail after `timeout`.
 * - Negative (`.not`) and exact-count matchers wait until the agent is quiet for
 *   `quietFor`, then check once.
 * - Text matchers read the transcript (what a person would see), not raw payloads.
 *
 * Subjects, by matcher group:
 * - Slack: `SlackConversation`, `SlackThread`, `SlackMessage`, `SlackUser` (modals).
 * - GitHub: `GitHubIssue`, `GitHubPullRequest`, `GitHubCommit`, `GitHubReviewComment`.
 * - Linear: `LinearIssue`, `LinearAgentSession`, `LinearComment`.
 * - Notion: `NotionPage` (blocks and properties), `NotionDiscussion` (comments).
 * - Delivery: any `Delivery`. Calls: any channel fixture.
 *
 * Every matcher is built on a plain read method, so a test can also just read the value:
 *
 *   | Matcher                                         | Read method                                   |
 *   |-------------------------------------------------|-----------------------------------------------|
 *   | toContainText                                   | `transcript()`                                |
 *   | toHaveReplyFrom, toHaveRepliesFrom              | `thread.replies()`, `thread.latestReply()`    |
 *   | toHaveChannelMessageFrom                        | `conversation.messages()`                     |
 *   | toHaveStreamingReplyFrom                        | `message.stream`                              |
 *   | toHaveStatus, toHaveStatusText                  | `thread.status()`                             |
 *   | toHaveButton                                    | `message.blocks`, transcript `controls`       |
 *   | toHaveReaction                                  | `message.reactions()`                         |
 *   | toHaveOpenedModal                               | `user.waitForModal()`                         |
 *   | toBeEphemeralFor                                | `message.visibleTo`                           |
 *   | toHaveCommentFrom, toHaveCommentsFrom           | `comments()`, `latestComment()`               |
 *   | toHaveReviewComment, toHaveReviewFrom           | `pr.reviewComments()`, `pr.reviews()`         |
 *   | toHaveCheckRun                                  | `checkRuns()`                                 |
 *   | toHaveLabel                                     | `issue.labels()`                              |
 *   | toBeMerged                                      | `pr.merged()`                                 |
 *   | toHaveSessionState                              | `session.state()`                             |
 *   | toHaveActivity                                  | `session.activities()`                        |
 *   | toBeAssignedTo, toBeDelegatedTo, toHaveState    | `issue.assignee()`, `delegatedTo()`, `state()`|
 *   | toHaveBlock                                     | `page.markdown()`, `page.blocks()`            |
 *   | toHavePropertyValue                             | `page.property()`                             |
 *   | toBeAccepted, toBeRejected, toBeRetried         | `delivery.attempts`, `delivery.status`        |
 *   | toHaveReceivedCall                              | `calls()`                                     |
 *
 * `R` is the framework's return type (`void` in Vitest, wrapped in a Promise here).
 */
export interface ChannelstackMatchers<R = unknown> {
  // ---------------------------------------------------------------- any transcript
  /** Some entry a person would see contains this text. `count` makes it exact. */
  toContainText(text: string | RegExp, options?: TextOptions & { count?: number }): Promise<R>;

  // ---------------------------------------------------------------- Slack
  /** The thread (or DM) has at least one reply from this author. */
  toHaveReplyFrom(author: AuthorRef, options?: WaitOptions & { text?: string | RegExp }): Promise<R>;
  /**
   * Exactly `count` replies from this author, checked once the agent is quiet.
   * `{ count: 1 }` catches duplicate answers caused by retries.
   */
  toHaveRepliesFrom(author: AuthorRef, options: QuietOptions & { count: number; text?: string | RegExp }): Promise<R>;
  /**
   * Subject: a conversation. A message from this author posted directly in the channel,
   * outside any thread. Use `.not` to catch an agent answering in the channel instead of the thread.
   */
  toHaveChannelMessageFrom(author: AuthorRef, options?: QuietOptions): Promise<R>;
  /** A reply from this author is being streamed right now. */
  toHaveStreamingReplyFrom(author?: AuthorRef, options?: WaitOptions): Promise<R>;
  /**
   * The agent's state in this thread:
   * `working` (status line set), `streaming`, `stopped` (after Stop), `idle` (done).
   */
  toHaveStatus(state: "working" | "streaming" | "stopped" | "idle", options?: WaitOptions): Promise<R>;
  /** The status line text the agent set (`assistant.threads.setStatus`). */
  toHaveStatusText(text: string | RegExp, options?: WaitOptions): Promise<R>;
  /** The message (or the latest agent message in a thread) has a button with this label. */
  toHaveButton(label: string | RegExp, options?: WaitOptions): Promise<R>;
  toHaveReaction(emoji: string, options?: WaitOptions & { by?: AuthorRef }): Promise<R>;
  /** Subject: a `SlackUser`. The agent opened a modal for this person. */
  toHaveOpenedModal(title?: string | RegExp, options?: WaitOptions): Promise<R>;
  /** Subject: a `SlackMessage`. Only this person can see it. */
  toBeEphemeralFor(user: SlackUser): Promise<R>;

  // ---------------------------------------------------------------- GitHub, Linear, Notion comments
  /**
   * Subject: a GitHub issue or pull request, a Linear issue, or a Notion discussion (a page's
   * comments live in its discussions: `comment.discussion`, `page.discussions()`).
   * At least one comment from this author.
   */
  toHaveCommentFrom(author: AuthorRef, options?: WaitOptions & { text?: string | RegExp }): Promise<R>;
  /** Subject: as for `toHaveCommentFrom`. Exactly `count` comments from this author. Catches self-trigger loops and duplicates. */
  toHaveCommentsFrom(author: AuthorRef, options: QuietOptions & { count: number }): Promise<R>;

  // ---------------------------------------------------------------- GitHub
  /** Subject: a pull request. An inline review comment, matched by any of the given fields. */
  toHaveReviewComment(expected: { path?: string; line?: number; from?: AuthorRef; text?: string | RegExp }, options?: WaitOptions): Promise<R>;
  /** Subject: a pull request. A review from this author, optionally with this state. */
  toHaveReviewFrom(author: AuthorRef, options?: WaitOptions & { state?: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" }): Promise<R>;
  /** Subject: a pull request or commit. A check run with this name, optionally in this state. */
  toHaveCheckRun(name: string | RegExp, options?: WaitOptions & {
    status?: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
  }): Promise<R>;
  toHaveLabel(name: string, options?: WaitOptions): Promise<R>;
  toBeMerged(options?: WaitOptions): Promise<R>;

  // ---------------------------------------------------------------- Linear
  /** Subject: an issue (latest session) or a session. */
  toHaveSessionState(state: "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale", options?: WaitOptions): Promise<R>;
  /** Subject: an issue (latest session) or a session. An activity of the agent's matching all given fields: a person's prompts (delegating's first among them) don't count. */
  toHaveActivity(expected: { type?: "thought" | "action" | "elicitation" | "response" | "error"; from?: AuthorRef; text?: string | RegExp }, options?: WaitOptions): Promise<R>;
  toBeAssignedTo(user: Principal | undefined, options?: WaitOptions): Promise<R>;
  toBeDelegatedTo(app: Principal | undefined, options?: WaitOptions): Promise<R>;
  /** Subject: a Linear issue. Its workflow state name. */
  toHaveState(name: string, options?: WaitOptions): Promise<R>;

  // ---------------------------------------------------------------- Notion
  /** Subject: a page. Some block contains this text (as the agent last left the page). */
  toHaveBlock(text: string | RegExp, options?: WaitOptions): Promise<R>;
  /** Subject: a page in a database. */
  toHavePropertyValue(name: string, value: unknown, options?: WaitOptions): Promise<R>;

  // ---------------------------------------------------------------- deliveries
  // Fake mode only, except GitHub live (read from the App's delivery log).
  /** Subject: a `Delivery`. The agent answered 2xx, within the platform's window by default (Slack: 3s). */
  toBeAccepted(options?: { within?: Duration } & WaitOptions): Promise<R>;
  /** Subject: a `Delivery` sent with a bad signature or stale timestamp. The agent refused it (4xx). */
  toBeRejected(options?: WaitOptions): Promise<R>;
  /** Subject: a `Delivery`. It needed retries (the agent didn't ack the first attempt in time). */
  toBeRetried(options?: { times?: number } & WaitOptions): Promise<R>;

  // ---------------------------------------------------------------- API calls
  /** Subject: a channel fixture. The agent made this API call. Fake mode, or live when the agent runs in proxy mode. */
  toHaveReceivedCall(operation: string | RegExp, options?: QuietOptions & { times?: number; error?: string }): Promise<R>;
}

export interface TextOptions extends QuietOptions {
  /** Only entries by this author. */
  from?: AuthorRef;
  /** Slack only: read the transcript as this person (ephemeral messages included only for them). */
  as?: Principal;
}

export type { Delivery };
