import { GitHubRefusal } from "../kit.ts";
import type { GitHubInlineComment, GitHubReviewEvent } from "../pulls.ts";
import {
  type Call,
  invalid,
  type Json,
  list,
  notFound,
  numberParam,
  page,
  people,
  pullOf,
  type Register,
  text,
} from "./shared.ts";

const EVENTS: readonly string[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

/** Pull requests, reviews and the comments on the diff. */
export function registerPulls(register: Register): void {
  const read = ["pull_requests", "read"] as const;
  const write = ["pull_requests", "write"] as const;

  const reviewEvent = (body: Json): GitHubReviewEvent | undefined => {
    const event = text(body, "event");
    if (event !== undefined && !EVENTS.includes(event)) throw invalid("PullRequestReview", "event", "invalid");
    return event as GitHubReviewEvent | undefined;
  };
  /** A comment on the diff as the API takes it: `line` and `side`, with `start_line` for a range. */
  const inlineOf = (input: Json): GitHubInlineComment => {
    const path = text(input, "path");
    const body = text(input, "body");
    if (path === undefined) throw invalid("PullRequestReviewComment", "path");
    if (body === undefined) throw invalid("PullRequestReviewComment", "body");
    if (typeof input.line !== "number") {
      // `position` is the older way to place a comment; the fake takes `line`, as GitHub's docs ask for.
      throw new GitHubRefusal(422, "Validation Failed", [
        { resource: "PullRequestReviewComment", code: "missing_field", field: "line" },
      ]);
    }
    return {
      path,
      body,
      line: input.line,
      side: input.side === "LEFT" ? "LEFT" : "RIGHT",
      startLine: typeof input.start_line === "number" ? input.start_line : undefined,
    };
  };
  const reviewCommentOf = ({ c, world, repo }: Call) => {
    const comment = world.kit.store
      .reviewCommentsOf(repo)
      .find((candidate) => candidate.id === numberParam(c, "comment"));
    if (!comment) throw notFound();
    return { comment, pull: world.kit.requirePull(repo, comment.pull) };
  };
  const reviewOf = (call: Call) => {
    const pull = pullOf(call);
    const review = call.world.kit.store
      .reviewsOf(call.repo, pull.number)
      .find((candidate) => candidate.id === numberParam(call.c, "review"));
    if (!review) throw notFound();
    return { pull, review };
  };

  register("get", "/pulls", read, ({ c, world, repo }) => {
    const state = c.req.query("state") ?? "open";
    const head = c.req.query("head")?.split(":").at(-1);
    const base = c.req.query("base");
    const pulls = world.kit.store
      .issuesOf(repo)
      .filter((issue) => issue.pull !== undefined && (state === "all" || issue.state === state))
      .filter(
        (issue) =>
          (head === undefined || issue.pull?.head === head) && (base === undefined || issue.pull?.base === base),
      )
      .reverse();
    return c.json(page(c, pulls).map((issue) => world.kit.objects.pullRequest(issue)));
  });

  register("post", "/pulls", write, async ({ c, world, repo, body, bot }) => {
    const head = text(body, "head")?.split(":").at(-1);
    const base = text(body, "base");
    if (head === undefined) throw invalid("PullRequest", "head");
    if (base === undefined) throw invalid("PullRequest", "base");
    if (text(body, "title") === undefined) throw invalid("PullRequest", "title");
    const { issue } = await world.pulls.openPull(repo, bot, {
      head,
      base,
      title: text(body, "title"),
      body: text(body, "body"),
      draft: body.draft === true,
    });
    return c.json(world.kit.objects.pullRequest(issue), 201);
  });

  register("get", "/pulls/:number{[0-9]+}", read, (call) =>
    call.c.json(call.world.kit.objects.pullRequest(pullOf(call))),
  );

  register("patch", "/pulls/:number{[0-9]+}", write, (call) => {
    const { c, world, body, bot } = call;
    const pull = pullOf(call);
    const state = text(body, "state");
    if (state !== undefined && state !== "open" && state !== "closed") throw invalid("PullRequest", "state", "invalid");
    world.issues.updateIssue(pull, bot, {
      title: text(body, "title"),
      body: body.body === null ? null : text(body, "body"),
      state,
    });
    return c.json(world.kit.objects.pullRequest(pull));
  });

  register("get", "/pulls/:number{[0-9]+}/files", read, async (call) => {
    const { c, world, repo } = call;
    const pull = pullOf(call);
    const changes = await world.repos.pullChanges(repo, pull);
    return c.json(page(c, changes).map((change) => world.kit.objects.file(repo, pull.pull.headSha, change)));
  });

  register("get", "/pulls/:number{[0-9]+}/commits", read, async (call) => {
    const { c, world, repo } = call;
    const pull = pullOf(call);
    const commits = await world.kit.git.ahead(world.kit.dir(repo), pull.pull.baseSha, pull.pull.headSha);
    return c.json(
      page(c, commits).map((info) => {
        const who = world.repos.commitAuthor(repo, info);
        return world.kit.objects.commit(repo, info, { author: who, committer: who });
      }),
    );
  });

  // --- Merging ------------------------------------------------------------------------------

  register("get", "/pulls/:number{[0-9]+}/merge", read, (call) => {
    if (!pullOf(call).pull.merged) throw notFound();
    return call.c.body(null, 204);
  });

  register("put", "/pulls/:number{[0-9]+}/merge", ["contents", "write"], async (call) => {
    const { c, world, body, bot } = call;
    const method = text(body, "merge_method") ?? "merge";
    if (method !== "merge" && method !== "squash" && method !== "rebase")
      throw invalid("PullRequest", "merge_method", "invalid");
    const { sha } = await world.pulls.merge(pullOf(call), bot, {
      method,
      title: text(body, "commit_title"),
      message: text(body, "commit_message"),
    });
    return c.json({ sha, merged: true, message: "Pull Request successfully merged" });
  });

  // --- Review requests ------------------------------------------------------------------------

  register("get", "/pulls/:number{[0-9]+}/requested_reviewers", read, (call) =>
    call.c.json({
      users: pullOf(call).pull.requestedReviewers.map((id) => call.world.kit.objects.actor(id)),
      teams: [],
    }),
  );

  register("post", "/pulls/:number{[0-9]+}/requested_reviewers", write, (call) => {
    const pull = pullOf(call);
    const reviewers = people(call, list(call.body, "reviewers") ?? []);
    if (reviewers.includes(call.bot)) {
      throw new GitHubRefusal(
        422,
        "Reviews may only be requested from collaborators. One or more of the users or teams you specified is not a collaborator of the repository.",
      );
    }
    call.world.pulls.requestReviewers(pull, call.bot, reviewers);
    return call.c.json(call.world.kit.objects.pullRequest(pull), 201);
  });

  // --- Reviews --------------------------------------------------------------------------------

  register("get", "/pulls/:number{[0-9]+}/reviews", read, (call) => {
    const { c, world, repo } = call;
    const pull = pullOf(call);
    return c.json(
      page(c, world.kit.store.reviewsOf(repo, pull.number)).map((review) => world.kit.objects.review(review, pull)),
    );
  });

  /** The review endpoints say what was wrong in plain sentences, not as error objects. */
  const inSentences = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof GitHubRefusal) || error.githubStatus !== 422) throw error;
      const sentences = (error.errors ?? []).map((entry) =>
        typeof entry === "string" ? entry : String(entry.message ?? entry.code),
      );
      throw new GitHubRefusal(422, "Unprocessable Entity", sentences);
    }
  };

  register("post", "/pulls/:number{[0-9]+}/reviews", write, (call) => {
    const { c, world, body, bot } = call;
    const pull = pullOf(call);
    return inSentences(async () => {
      const { review } = await world.pulls.review(pull, bot, {
        event: reviewEvent(body),
        body: text(body, "body"),
        comments: (list(body, "comments") ?? []).map((comment) => inlineOf(comment as Json)),
      });
      return c.json(world.kit.objects.review(review, pull));
    });
  });

  register("get", "/pulls/:number{[0-9]+}/reviews/:review{[0-9]+}", read, (call) => {
    const { pull, review } = reviewOf(call);
    return call.c.json(call.world.kit.objects.review(review, pull));
  });

  register("post", "/pulls/:number{[0-9]+}/reviews/:review{[0-9]+}/events", write, (call) => {
    const { pull, review } = reviewOf(call);
    return inSentences(() => {
      const event = reviewEvent(call.body);
      if (event === undefined) throw invalid("PullRequestReview", "event");
      call.world.pulls.submitReview(pull, review, event, text(call.body, "body"));
      return call.c.json(call.world.kit.objects.review(review, pull));
    });
  });

  register("get", "/pulls/:number{[0-9]+}/reviews/:review{[0-9]+}/comments", read, (call) => {
    const { c, world, repo } = call;
    const { pull, review } = reviewOf(call);
    const comments = world.kit.store
      .reviewCommentsOf(repo, pull.number)
      .filter((comment) => comment.review === review.id);
    return c.json(page(c, comments).map((comment) => world.kit.objects.reviewComment(comment, pull)));
  });

  // --- Comments on the diff -------------------------------------------------------------------

  register("get", "/pulls/:number{[0-9]+}/comments", read, (call) => {
    const { c, world, repo } = call;
    const pull = pullOf(call);
    return c.json(
      page(c, world.kit.store.reviewCommentsOf(repo, pull.number)).map((comment) =>
        world.kit.objects.reviewComment(comment, pull),
      ),
    );
  });

  register("post", "/pulls/:number{[0-9]+}/comments", write, async (call) => {
    const { c, world, repo, body, bot } = call;
    const pull = pullOf(call);
    // `in_reply_to` turns the call into a reply in an existing thread.
    if (typeof body.in_reply_to === "number") {
      const to = world.kit.store.reviewCommentsOf(repo, pull.number).find((comment) => comment.id === body.in_reply_to);
      if (!to) throw notFound();
      return c.json(
        world.kit.objects.reviewComment(world.pulls.reply(pull, bot, to, text(body, "body") ?? ""), pull),
        201,
      );
    }
    const comment = await world.pulls.reviewComment(pull, bot, inlineOf(body));
    return c.json(world.kit.objects.reviewComment(comment, pull), 201);
  });

  register("post", "/pulls/:number{[0-9]+}/comments/:comment{[0-9]+}/replies", write, (call) => {
    const { c, world, body, bot } = call;
    const { comment, pull } = reviewCommentOf(call);
    if (pull.number !== numberParam(c, "number")) throw notFound();
    return c.json(
      world.kit.objects.reviewComment(world.pulls.reply(pull, bot, comment, text(body, "body") ?? ""), pull),
      201,
    );
  });

  register("get", "/pulls/comments/:comment{[0-9]+}", read, (call) => {
    const { comment, pull } = reviewCommentOf(call);
    return call.c.json(call.world.kit.objects.reviewComment(comment, pull));
  });

  register("patch", "/pulls/comments/:comment{[0-9]+}", write, (call) => {
    const { comment, pull } = reviewCommentOf(call);
    const body = text(call.body, "body");
    if (body === undefined) throw invalid("PullRequestReviewComment", "body");
    call.world.pulls.editReviewComment(pull, comment, body);
    return call.c.json(call.world.kit.objects.reviewComment(comment, pull));
  });

  register("delete", "/pulls/comments/:comment{[0-9]+}", write, (call) => {
    const { comment, pull } = reviewCommentOf(call);
    call.world.pulls.deleteReviewComment(pull, comment);
    return call.c.body(null, 204);
  });
}
