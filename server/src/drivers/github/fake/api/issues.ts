import { type GitHubReactionContent, REACTIONS } from "../../world.ts";
import { GitHubRefusal } from "../kit.ts";
import {
  type Call,
  invalid,
  issueOf,
  list,
  notFound,
  numberParam,
  page,
  people,
  type Register,
  text,
} from "./shared.ts";

/** Issues, their comments, labels, assignees and reactions. */
export function registerIssues(register: Register): void {
  const read = ["issues", "read"] as const;
  const write = ["issues", "write"] as const;

  const commentOf = ({ c, world, repo }: Call) => {
    const comment = world.kit.store.comments.find(String(numberParam(c, "comment")));
    // A comment that was deleted is gone from its repository's listing.
    if (!comment || !world.kit.store.commentsOn(repo, comment.issue).includes(comment)) throw notFound();
    return comment;
  };
  /** Who an issue can be assigned to. GitHub drops, without a word, anyone who can't be: an App's bot among them. */
  const assignable = (call: Call, logins: readonly unknown[]) => people(call, logins).filter((id) => id !== call.bot);
  const labelNames = (body: Call["body"]): string[] =>
    (Array.isArray(body) ? body : (list(body, "labels") ?? [])).flatMap((label) =>
      typeof label === "string"
        ? [label]
        : typeof (label as { name?: unknown })?.name === "string"
          ? [(label as { name: string }).name]
          : [],
    );

  register("get", "/issues", read, ({ c, world, repo }) => {
    const state = c.req.query("state") ?? "open";
    const labels = (c.req.query("labels") ?? "").split(",").filter(Boolean);
    const issues = world.kit.store
      .issuesOf(repo)
      .filter((issue) => state === "all" || issue.state === state)
      .filter((issue) => labels.every((label) => issue.labels.some((has) => has.toLowerCase() === label.toLowerCase())))
      // Newest first, as GitHub lists by default.
      .reverse();
    return c.json(page(c, issues).map((issue) => world.kit.objects.issue(issue)));
  });

  register("post", "/issues", write, (call) => {
    const { c, world, repo, body, bot } = call;
    const title = text(body, "title");
    if (title === undefined) throw invalid("Issue", "title");
    const { issue } = world.issues.openIssue(repo, bot, {
      title,
      body: text(body, "body"),
      labels: labelNames(body),
      assignees: assignable(call, list(body, "assignees") ?? []),
    });
    return c.json(world.kit.objects.issue(issue), 201);
  });

  register("get", "/issues/:number{[0-9]+}", read, (call) => call.c.json(call.world.kit.objects.issue(issueOf(call))));

  register("patch", "/issues/:number{[0-9]+}", write, (call) => {
    const { c, world, body, bot } = call;
    const issue = issueOf(call);
    const state = text(body, "state");
    if (state !== undefined && state !== "open" && state !== "closed") throw invalid("Issue", "state", "invalid");
    world.issues.updateIssue(issue, bot, {
      title: text(body, "title"),
      body: body.body === null ? null : text(body, "body"),
      state,
      stateReason: text(body, "state_reason") as "completed" | "not_planned" | "reopened" | undefined,
    });
    // `labels` and `assignees` in an update replace what is there.
    if (body.labels !== undefined) {
      const wanted = labelNames(body);
      const lower = wanted.map((name) => name.toLowerCase());
      world.issues.removeLabels(
        issue,
        bot,
        issue.labels.filter((has) => !lower.includes(has.toLowerCase())),
      );
      world.issues.addLabels(issue, bot, wanted);
    }
    if (body.assignees !== undefined) {
      const wanted = assignable(call, list(body, "assignees") ?? []);
      world.issues.unassign(
        issue,
        bot,
        issue.assignees.filter((has) => !wanted.includes(has)),
      );
      world.issues.assign(issue, bot, wanted);
    }
    return c.json(world.kit.objects.issue(issue));
  });

  // --- Comments -----------------------------------------------------------------------------

  register("get", "/issues/:number{[0-9]+}/comments", read, (call) => {
    const { c, world, repo } = call;
    const issue = issueOf(call);
    return c.json(
      page(c, world.kit.store.commentsOn(repo, issue.number)).map((comment) =>
        world.kit.objects.comment(comment, issue),
      ),
    );
  });

  register("post", "/issues/:number{[0-9]+}/comments", write, (call) => {
    const { c, world, body, bot } = call;
    const issue = issueOf(call);
    const content = text(body, "body");
    if (content === undefined) throw invalid("IssueComment", "body");
    return c.json(world.kit.objects.comment(world.issues.comment(issue, bot, content), issue), 201);
  });

  register("get", "/issues/comments/:comment{[0-9]+}", read, (call) => {
    const comment = commentOf(call);
    return call.c.json(call.world.kit.objects.comment(comment, call.world.kit.requireIssue(call.repo, comment.issue)));
  });

  register("patch", "/issues/comments/:comment{[0-9]+}", write, (call) => {
    const { c, world, repo, body, bot } = call;
    const comment = commentOf(call);
    const content = text(body, "body");
    if (content === undefined) throw invalid("IssueComment", "body");
    world.issues.editComment(comment, bot, content);
    return c.json(world.kit.objects.comment(comment, world.kit.requireIssue(repo, comment.issue)));
  });

  register("delete", "/issues/comments/:comment{[0-9]+}", write, (call) => {
    call.world.issues.deleteComment(commentOf(call), call.bot);
    return call.c.body(null, 204);
  });

  // --- Labels and assignees of an issue --------------------------------------------------------

  const labelsJson = (call: Call, issue: ReturnType<typeof issueOf>) =>
    issue.labels.flatMap((name) => {
      const label = call.repo.labels.get(name.toLowerCase());
      return label ? [call.world.kit.objects.label(call.repo, label)] : [];
    });

  register("get", "/issues/:number{[0-9]+}/labels", read, (call) => call.c.json(labelsJson(call, issueOf(call))));

  register("post", "/issues/:number{[0-9]+}/labels", write, (call) => {
    const issue = issueOf(call);
    call.world.issues.addLabels(issue, call.bot, labelNames(call.body));
    return call.c.json(labelsJson(call, issue));
  });

  register("put", "/issues/:number{[0-9]+}/labels", write, (call) => {
    const issue = issueOf(call);
    const wanted = labelNames(call.body);
    const lower = wanted.map((name) => name.toLowerCase());
    call.world.issues.removeLabels(
      issue,
      call.bot,
      issue.labels.filter((has) => !lower.includes(has.toLowerCase())),
    );
    call.world.issues.addLabels(issue, call.bot, wanted);
    return call.c.json(labelsJson(call, issue));
  });

  register("delete", "/issues/:number{[0-9]+}/labels", write, (call) => {
    const issue = issueOf(call);
    call.world.issues.removeLabels(issue, call.bot, [...issue.labels]);
    return call.c.body(null, 204);
  });

  register("delete", "/issues/:number{[0-9]+}/labels/:name", write, (call) => {
    const issue = issueOf(call);
    call.world.issues.removeLabels(issue, call.bot, [call.c.req.param("name") ?? ""]);
    return call.c.json(labelsJson(call, issue));
  });

  register("post", "/issues/:number{[0-9]+}/assignees", write, (call) => {
    const issue = issueOf(call);
    call.world.issues.assign(issue, call.bot, assignable(call, list(call.body, "assignees") ?? []));
    return call.c.json(call.world.kit.objects.issue(issue), 201);
  });

  register("delete", "/issues/:number{[0-9]+}/assignees", write, (call) => {
    const issue = issueOf(call);
    call.world.issues.unassign(issue, call.bot, people(call, list(call.body, "assignees") ?? []));
    return call.c.json(call.world.kit.objects.issue(issue));
  });

  // --- Reactions ------------------------------------------------------------------------------

  /** The reaction routes of one kind of thing: list, add (200 when it was there already), remove. */
  const reactions = (path: string, target: (call: Call) => Parameters<Call["world"]["issues"]["react"]>[0]) => {
    register("get", `${path}/reactions`, read, (call) =>
      call.c.json(page(call.c, target(call).reactions).map((reaction) => call.world.kit.objects.reaction(reaction))),
    );
    register("post", `${path}/reactions`, write, (call) => {
      const content = text(call.body, "content") as GitHubReactionContent | undefined;
      if (content === undefined || !REACTIONS.includes(content)) {
        throw new GitHubRefusal(422, "Validation Failed", [
          { resource: "Reaction", code: "invalid", field: "content" },
        ]);
      }
      const { reaction, created } = call.world.issues.react(target(call), call.bot, content);
      return call.c.json(call.world.kit.objects.reaction(reaction), created ? 201 : 200);
    });
    register("delete", `${path}/reactions/:reaction{[0-9]+}`, write, (call) => {
      call.world.issues.unreact(target(call), numberParam(call.c, "reaction"));
      return call.c.body(null, 204);
    });
  };
  reactions("/issues/:number{[0-9]+}", issueOf);
  reactions("/issues/comments/:comment{[0-9]+}", commentOf);
  reactions("/pulls/comments/:comment{[0-9]+}", ({ c, world, repo }) => {
    const comment = world.kit.store
      .reviewCommentsOf(repo)
      .find((candidate) => candidate.id === numberParam(c, "comment"));
    if (!comment) throw notFound();
    return comment;
  });
}
