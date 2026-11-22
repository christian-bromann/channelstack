import { githubNodeId } from "../../../core/ids/index.ts";
import type {
  GitHubFileChange,
  GitHubIssueRecord,
  GitHubRepoRecord,
  GitHubReviewCommentRecord,
  GitHubReviewRecord,
  GitHubReviewState,
} from "../world.ts";
import type { GitHubIssues } from "./issues.ts";
import { type GitHubKit, GitHubRefusal, invalid } from "./kit.ts";
import type { GitHubRepos } from "./repos.ts";

type Pull = GitHubIssueRecord & { pull: NonNullable<GitHubIssueRecord["pull"]> };
export type GitHubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface GitHubPullInput {
  head: string;
  base?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  draft?: boolean | undefined;
}

export interface GitHubInlineComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT" | undefined;
  startLine?: number | undefined;
  body: string;
}

const STATE_FOR: Readonly<Record<GitHubReviewEvent, GitHubReviewState>> = {
  COMMENT: "COMMENTED",
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
};

/** A refusal with GitHub's own sentence about one field. */
const refused = (resource: string, field: string, message: string) => invalid(resource, field, { message });

/** The part of a file's patch a comment on `line` shows: its hunk, down to that line. */
function hunkUpTo(change: GitHubFileChange, line: number, side: "LEFT" | "RIGHT"): string {
  const out: string[] = [];
  let [left, right] = [0, 0];
  for (const text of (change.patch ?? "").split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      out.length = 0;
      [left, right] = [Number(header[1]), Number(header[2])];
      out.push(text);
      continue;
    }
    out.push(text);
    // "\ No newline at end of file" belongs to the line before it, on neither side.
    if (text.startsWith("\\")) continue;
    const [onLeft, onRight] = [!text.startsWith("+"), !text.startsWith("-")];
    if ((side === "LEFT" && onLeft && left === line) || (side === "RIGHT" && onRight && right === line)) break;
    if (onLeft) left++;
    if (onRight) right++;
  }
  return out.join("\n");
}

/** Pull requests: opening, reviewing, the threads on the diff, and merging. */
export function createPulls(kit: GitHubKit, repos: GitHubRepos, issues: GitHubIssues) {
  const { context, store, git, objects } = kit;
  const { ids, clock } = context;

  const { touch } = kit;

  const newReview = (pull: Pull, author: number, state: GitHubReviewState, body: string): GitHubReviewRecord =>
    store.add(store.reviews, store.sessionOf(store.repo(pull.repo)), {
      id: Number(ids.next("github.review")),
      repo: pull.repo,
      pull: pull.number,
      author,
      state,
      body,
      commitSha: pull.pull.headSha,
      submittedAt: state === "PENDING" ? undefined : clock(),
      delivery: undefined,
    });

  /** Tell the App about a submitted review. */
  const submitted = (pull: Pull, review: GitHubReviewRecord): void => {
    review.delivery = kit.emit(store.repo(pull.repo), "pull_request_review", review.author, {
      action: "submitted",
      // The REST API writes a review's state in capitals; webhooks write it in lower case.
      review: { ...objects.review(review, pull), state: review.state.toLowerCase() },
      pull_request: objects.pullRequest(pull),
    });
  };

  /**
   * May this person submit a review with this verdict? Not an approval or a change request on
   * their own pull request, and not one that says nothing. Asked for a new review and for a
   * pending one alike.
   */
  const maySubmit = (
    pull: Pull,
    author: number,
    event: GitHubReviewEvent,
    body: string,
    hasComments: boolean,
  ): void => {
    if (event !== "COMMENT" && author === pull.author) {
      const what = event === "APPROVE" ? "approve" : "request changes on";
      throw refused("PullRequestReview", "event", `Can not ${what} your own pull request`);
    }
    if (body.trim() !== "" || hasComments) return;
    if (event === "REQUEST_CHANGES") {
      throw refused("PullRequestReview", "body", "You need to leave a comment indicating the requested changes.");
    }
    if (event === "COMMENT") throw refused("PullRequestReview", "body", "Body can't be blank");
  };

  /** A review was submitted: its author is no longer asked for one, and the App hears about its comments and the review. */
  const announce = (pull: Pull, review: GitHubReviewRecord, comments: readonly GitHubReviewCommentRecord[]): void => {
    pull.pull.requestedReviewers = pull.pull.requestedReviewers.filter((reviewer) => reviewer !== review.author);
    touch(pull);
    for (const comment of comments) comment.delivery = commentEvent(pull, comment, "created");
    submitted(pull, review);
  };

  /** A comment on the diff. GitHub refuses a line that isn't part of it. */
  const inline = async (
    pull: Pull,
    review: GitHubReviewRecord,
    author: number,
    input: GitHubInlineComment,
  ): Promise<GitHubReviewCommentRecord> => {
    const repo = store.repo(pull.repo);
    const side = input.side ?? "RIGHT";
    const change = (await repos.pullChanges(repo, pull)).find((candidate) => candidate.path === input.path);
    if (!change) {
      throw refused(
        "PullRequestReviewComment",
        "pull_request_review_thread.path",
        "pull_request_review_thread.path could not be resolved",
      );
    }
    for (const line of input.startLine === undefined ? [input.line] : [input.startLine, input.line]) {
      if (!(side === "RIGHT" ? change.rightLines : change.leftLines).includes(line)) {
        throw refused(
          "PullRequestReviewComment",
          "pull_request_review_thread.line",
          "pull_request_review_thread.line must be part of the diff",
        );
      }
    }
    if (input.body.trim() === "") throw refused("PullRequestReviewComment", "body", "body can't be blank");
    const now = clock();
    const id = Number(ids.next("github.comment"));
    return store.add(store.reviewComments, store.sessionOf(repo), {
      id,
      repo: repo.id,
      pull: pull.number,
      review: review.id,
      author,
      path: input.path,
      line: input.line,
      startLine: input.startLine,
      side,
      body: input.body,
      commitSha: pull.pull.headSha,
      diffHunk: hunkUpTo(change, input.line, side),
      thread: id,
      inReplyTo: undefined,
      reactions: [],
      createdAt: now,
      updatedAt: now,
      delivery: undefined,
    });
  };

  const commentEvent = (pull: Pull, comment: GitHubReviewCommentRecord, action: string, extra: object = {}) =>
    kit.emit(store.repo(pull.repo), "pull_request_review_comment", comment.author, {
      action,
      ...extra,
      comment: objects.reviewComment(comment, pull),
      pull_request: objects.pullRequest(pull),
    });

  /**
   * The thread a comment on the diff is in, oldest comment first. The first one left is the
   * thread's head: when the comment that started a thread is deleted, the rest stay one thread.
   */
  const threadOf = (comment: GitHubReviewCommentRecord): GitHubReviewCommentRecord[] =>
    store
      .reviewCommentsOf(store.repo(comment.repo), comment.pull)
      .filter((candidate) => candidate.thread === comment.thread);

  return {
    threadOf,
    isResolved: (comment: GitHubReviewCommentRecord) => store.resolvedThreads.has(comment.thread),

    async openPull(
      repo: GitHubRepoRecord,
      actor: number,
      input: GitHubPullInput,
    ): Promise<{ issue: Pull; delivery: string | undefined }> {
      const dir = kit.dir(repo);
      const base = input.base ?? repo.defaultBranch;
      const [headSha, baseSha] = await Promise.all([git.branch(dir, input.head), git.branch(dir, base)]);
      if (!headSha) throw refused("PullRequest", "head", "head is invalid");
      if (!baseSha) throw refused("PullRequest", "base", "base is invalid");
      const commits = await git.ahead(dir, baseSha, headSha);
      if (commits.length === 0) {
        throw new GitHubRefusal(422, "Validation Failed", [
          { resource: "PullRequest", code: "custom", message: `No commits between ${base} and ${input.head}` },
        ]);
      }
      const open = store
        .issuesOf(repo)
        .find((issue) => issue.state === "open" && issue.pull?.head === input.head && issue.pull.base === base);
      if (open) {
        throw new GitHubRefusal(422, "Validation Failed", [
          {
            resource: "PullRequest",
            code: "custom",
            message: `A pull request already exists for ${repo.owner}:${input.head}.`,
          },
        ]);
      }
      // GitHub suggests the commit's subject for a single commit; the fake does the same when no title is given.
      const title = input.title ?? commits.at(-1)?.message.split("\n", 1)[0] ?? input.head;
      const issue = issues.newIssue(repo, actor, title, input.body);
      issue.pull = {
        id: Number(ids.next("github.pull")),
        head: input.head,
        base,
        headSha,
        baseSha,
        draft: input.draft ?? false,
        merged: false,
        mergedAt: undefined,
        mergedBy: undefined,
        mergeCommitSha: undefined,
        requestedReviewers: [],
        stats: { commits: 0, additions: 0, deletions: 0, changedFiles: 0 },
      };
      await repos.refreshPull(repo, issue);
      return { issue: issue as Pull, delivery: kit.issueEvent(issue, actor, "opened") };
    },

    requestReviewers(pull: Pull, actor: number, reviewers: readonly number[]): Array<string | undefined> {
      const deliveries: Array<string | undefined> = [];
      for (const reviewer of reviewers) {
        if (reviewer === pull.author)
          throw refused("PullRequest", "reviewers", "Review cannot be requested from pull request author.");
        if (pull.pull.requestedReviewers.includes(reviewer)) continue;
        pull.pull.requestedReviewers.push(reviewer);
        touch(pull);
        deliveries.push(
          kit.issueEvent(pull, actor, "review_requested", { requested_reviewer: objects.actor(reviewer) }),
        );
      }
      return deliveries;
    },

    markReady(pull: Pull, actor: number): string | undefined {
      if (!pull.pull.draft) throw refused("PullRequest", "draft", "The pull request is not a draft");
      pull.pull.draft = false;
      touch(pull);
      return kit.issueEvent(pull, actor, "ready_for_review");
    },

    /**
     * Review a pull request: a verdict, a body, comments on the diff. Without `event` the review
     * stays pending until it is submitted. Everything is checked before anything is kept.
     */
    async review(
      pull: Pull,
      actor: number,
      input: {
        event?: GitHubReviewEvent | undefined;
        body?: string | undefined;
        comments?: readonly GitHubInlineComment[] | undefined;
      },
    ): Promise<{ review: GitHubReviewRecord; comments: GitHubReviewCommentRecord[] }> {
      const body = input.body ?? "";
      const comments = input.comments ?? [];
      if (input.event !== undefined) maySubmit(pull, actor, input.event, body, comments.length > 0);
      const review = newReview(pull, actor, input.event === undefined ? "PENDING" : STATE_FOR[input.event], body);
      const made: GitHubReviewCommentRecord[] = [];
      try {
        for (const comment of comments) made.push(await inline(pull, review, actor, comment));
      } catch (error) {
        // A comment GitHub refuses refuses the whole review: nothing of it stays.
        const session = store.sessionOf(store.repo(pull.repo));
        for (const comment of made) store.forget(store.reviewComments, session, comment.id);
        store.forget(store.reviews, session, review.id);
        throw error;
      }
      if (review.state !== "PENDING") announce(pull, review, made);
      return { review, comments: made };
    },

    /** Submit a pending review. */
    submitReview(pull: Pull, review: GitHubReviewRecord, event: GitHubReviewEvent, body: string | undefined): void {
      if (review.state !== "PENDING") {
        throw refused("PullRequestReview", "event", "Can not submit a review that was already submitted");
      }
      const comments = store
        .reviewCommentsOf(store.repo(pull.repo), pull.number)
        .filter((comment) => comment.review === review.id);
      maySubmit(pull, review.author, event, body ?? review.body, comments.length > 0);
      review.state = STATE_FOR[event];
      review.body = body ?? review.body;
      review.submittedAt = clock();
      announce(pull, review, comments);
    },

    /** One comment on the diff, outside a review. GitHub wraps it in a review of its own. */
    async reviewComment(pull: Pull, actor: number, input: GitHubInlineComment): Promise<GitHubReviewCommentRecord> {
      const review = newReview(pull, actor, "COMMENTED", "");
      let comment: GitHubReviewCommentRecord;
      try {
        comment = await inline(pull, review, actor, input);
      } catch (error) {
        store.forget(store.reviews, store.sessionOf(store.repo(pull.repo)), review.id);
        throw error;
      }
      touch(pull);
      comment.delivery = commentEvent(pull, comment, "created");
      submitted(pull, review);
      return comment;
    },

    /** Reply in a thread on the diff. A reply hangs on the thread's first comment, whichever comment was answered. */
    reply(pull: Pull, actor: number, to: GitHubReviewCommentRecord, body: string): GitHubReviewCommentRecord {
      if (body.trim() === "") throw refused("PullRequestReviewComment", "body", "body can't be blank");
      const [head = to] = threadOf(to);
      const review = newReview(pull, actor, "COMMENTED", "");
      const now = clock();
      const comment = store.add(store.reviewComments, store.sessionOf(store.repo(pull.repo)), {
        ...head,
        id: Number(ids.next("github.comment")),
        review: review.id,
        author: actor,
        body,
        inReplyTo: head.id,
        reactions: [],
        createdAt: now,
        updatedAt: now,
        delivery: undefined,
      });
      touch(pull);
      comment.delivery = commentEvent(pull, comment, "created");
      submitted(pull, review);
      return comment;
    },

    editReviewComment(pull: Pull, comment: GitHubReviewCommentRecord, body: string): string | undefined {
      const from = comment.body;
      comment.body = body;
      comment.updatedAt = clock();
      return commentEvent(pull, comment, "edited", { changes: { body: { from } } });
    },

    deleteReviewComment(pull: Pull, comment: GitHubReviewCommentRecord): string | undefined {
      store.forget(store.reviewComments, store.sessionOf(store.repo(pull.repo)), comment.id);
      return commentEvent(pull, comment, "deleted");
    },

    /** Resolve or reopen a thread on the diff. Sends `pull_request_review_thread`. */
    setResolved(pull: Pull, actor: number, comment: GitHubReviewCommentRecord, resolved: boolean): string | undefined {
      const repo = store.repo(pull.repo);
      if (resolved) store.resolvedThreads.add(comment.thread);
      else store.resolvedThreads.delete(comment.thread);
      const thread = threadOf(comment);
      return kit.emit(repo, "pull_request_review_thread", actor, {
        action: resolved ? "resolved" : "unresolved",
        thread: {
          node_id: githubNodeId("PullRequestReviewThread", [repo.id, comment.thread]),
          comments: thread.map((candidate) => objects.reviewComment(candidate, pull)),
        },
        pull_request: objects.pullRequest(pull),
      });
    },

    /** Merge a pull request: a merge commit, one squashed commit, or its commits replayed on the base. */
    async merge(
      pull: Pull,
      actor: number,
      options: {
        method?: "merge" | "squash" | "rebase" | undefined;
        title?: string | undefined;
        message?: string | undefined;
      },
    ): Promise<{ sha: string; delivery: string | undefined }> {
      const repo = store.repo(pull.repo);
      const dir = kit.dir(repo);
      if (pull.state !== "open") throw new GitHubRefusal(405, "Pull Request is not mergeable");
      if (pull.pull.draft) throw new GitHubRefusal(405, "Pull Request is still a draft");
      await repos.refreshPull(repo, pull);
      const { headSha, baseSha } = pull.pull;
      const start = (await git.mergeBase(dir, baseSha, headSha)) ?? baseSha;
      const files = await git.merged(dir, start, baseSha, headSha);
      if (!files) throw new GitHubRefusal(405, "Pull Request is not mergeable");
      const who = { ...kit.identity(store.actor(actor)), date: clock() };
      const method = options.method ?? "merge";
      let sha: string;
      if (method === "rebase") {
        // Each commit of the branch again, on top of the base, with the merger as committer.
        sha = baseSha;
        for (const commit of await git.ahead(dir, baseSha, headSha)) {
          const replayed = await git.merged(dir, commit.parents[0] ?? start, sha, commit.sha);
          if (!replayed) throw new GitHubRefusal(405, "Pull Request is not mergeable");
          sha = await git.writeCommit(dir, {
            message: commit.message,
            tree: await git.treeOf(dir, replayed),
            parents: [sha],
            author: commit.author,
            committer: who,
          });
        }
      } else {
        const subject =
          options.title ??
          (method === "squash"
            ? `${pull.title} (#${pull.number})`
            : `Merge pull request #${pull.number} from ${repo.owner}/${pull.pull.head}`);
        const text = options.message ?? (method === "squash" ? "" : pull.title);
        sha = await git.writeCommit(dir, {
          message: text === "" ? subject : `${subject}\n\n${text}`,
          tree: await git.treeOf(dir, files),
          parents: method === "squash" ? [baseSha] : [baseSha, headSha],
          author: method === "squash" ? { ...kit.identity(store.actor(pull.author)), date: clock() } : who,
          committer: who,
        });
      }
      store.commitActors.set(`${repo.id}:${sha}`, actor);
      const now = clock();
      Object.assign(pull.pull, { merged: true, mergedAt: now, mergedBy: actor, mergeCommitSha: sha });
      Object.assign(pull, { state: "closed", closedAt: now, closedBy: actor, updatedAt: now });
      await git.setBranch(dir, pull.pull.base, sha);
      // GitHub sends the push to the base branch, then says the pull request is closed.
      await repos.afterPush(repo, actor, pull.pull.base, baseSha, sha);
      return { sha, delivery: kit.issueEvent(pull, actor, "closed") };
    },
  };
}
