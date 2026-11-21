import type {
  GitHubFileChange,
  GitHubIssueRecord,
  GitHubRepoRecord,
  GitHubReviewCommentRecord,
  GitHubReviewRecord,
  GitHubReviewState,
} from "../world.ts";
import type { GitHubIssues } from "./issues.ts";
import { type GitHubKit, GitHubRefusal } from "./kit.ts";
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

const invalid = (resource: string, field: string, message: string) =>
  new GitHubRefusal(422, "Validation Failed", [{ resource, code: "custom", field, message }]);

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

  const touch = (issue: GitHubIssueRecord) => {
    issue.updatedAt = clock();
  };

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
      review: objects.review(review, pull),
      pull_request: objects.pullRequest(pull),
    });
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
      throw invalid(
        "PullRequestReviewComment",
        "pull_request_review_thread.path",
        "pull_request_review_thread.path could not be resolved",
      );
    }
    for (const line of input.startLine === undefined ? [input.line] : [input.startLine, input.line]) {
      if (!(side === "RIGHT" ? change.rightLines : change.leftLines).includes(line)) {
        throw invalid(
          "PullRequestReviewComment",
          "pull_request_review_thread.line",
          "pull_request_review_thread.line must be part of the diff",
        );
      }
    }
    if (input.body.trim() === "") throw invalid("PullRequestReviewComment", "body", "body can't be blank");
    const now = clock();
    return store.add(store.reviewComments, store.sessionOf(repo), {
      id: Number(ids.next("github.comment")),
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
      inReplyTo: undefined,
      resolved: false,
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

  /** The comment that started the thread a comment is in. */
  const rootOf = (comment: GitHubReviewCommentRecord): GitHubReviewCommentRecord =>
    comment.inReplyTo === undefined ? comment : (store.reviewComments.find(String(comment.inReplyTo)) ?? comment);

  return {
    rootOf,

    async openPull(
      repo: GitHubRepoRecord,
      actor: number,
      input: GitHubPullInput,
    ): Promise<{ issue: Pull; delivery: string | undefined }> {
      const dir = kit.dir(repo);
      const base = input.base ?? repo.defaultBranch;
      const [headSha, baseSha] = await Promise.all([git.branch(dir, input.head), git.branch(dir, base)]);
      if (!headSha) throw invalid("PullRequest", "head", "head is invalid");
      if (!baseSha) throw invalid("PullRequest", "base", "base is invalid");
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
          throw invalid("PullRequest", "reviewers", "Review cannot be requested from pull request author.");
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
      if (!pull.pull.draft) throw invalid("PullRequest", "draft", "The pull request is not a draft");
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
      if (input.event !== undefined && input.event !== "COMMENT" && actor === pull.author) {
        throw invalid(
          "PullRequestReview",
          "event",
          `Can not ${input.event === "APPROVE" ? "approve" : "request changes on"} your own pull request`,
        );
      }
      if (input.event === "REQUEST_CHANGES" && body.trim() === "" && comments.length === 0) {
        throw invalid("PullRequestReview", "body", "You need to leave a comment indicating the requested changes.");
      }
      if (input.event === "COMMENT" && body.trim() === "" && comments.length === 0) {
        throw invalid("PullRequestReview", "body", "Body can't be blank");
      }
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
      if (review.state !== "PENDING") {
        pull.pull.requestedReviewers = pull.pull.requestedReviewers.filter((reviewer) => reviewer !== actor);
        touch(pull);
        for (const comment of made) comment.delivery = commentEvent(pull, comment, "created");
        submitted(pull, review);
      }
      return { review, comments: made };
    },

    /** Submit a pending review. */
    submitReview(pull: Pull, review: GitHubReviewRecord, event: GitHubReviewEvent, body: string | undefined): void {
      if (review.state !== "PENDING")
        throw invalid("PullRequestReview", "event", "Can not submit a review that was already submitted");
      review.state = STATE_FOR[event];
      review.body = body ?? review.body;
      review.submittedAt = clock();
      touch(pull);
      for (const comment of store.reviewCommentsOf(store.repo(pull.repo), pull.number)) {
        if (comment.review === review.id) comment.delivery = commentEvent(pull, comment, "created");
      }
      submitted(pull, review);
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

    /** Reply in a thread on the diff. A reply always hangs on the comment that started the thread. */
    reply(pull: Pull, actor: number, to: GitHubReviewCommentRecord, body: string): GitHubReviewCommentRecord {
      if (body.trim() === "") throw invalid("PullRequestReviewComment", "body", "body can't be blank");
      const root = rootOf(to);
      const review = newReview(pull, actor, "COMMENTED", "");
      const now = clock();
      const comment = store.add(store.reviewComments, store.sessionOf(store.repo(pull.repo)), {
        ...root,
        id: Number(ids.next("github.comment")),
        review: review.id,
        author: actor,
        body,
        inReplyTo: root.id,
        resolved: false,
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
      const root = rootOf(comment);
      root.resolved = resolved;
      const thread = store
        .reviewCommentsOf(repo, pull.number)
        .filter((candidate) => candidate.id === root.id || candidate.inReplyTo === root.id);
      return kit.emit(repo, "pull_request_review_thread", actor, {
        action: resolved ? "resolved" : "unresolved",
        thread: {
          node_id: `PRRT_${Buffer.from(String(root.id)).toString("base64url")}`,
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

export type GitHubPulls = ReturnType<typeof createPulls>;
