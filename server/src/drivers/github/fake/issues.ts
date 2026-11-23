import type {
  GitHubCommentRecord,
  GitHubIssueRecord,
  GitHubMinimizeReason,
  GitHubReactionContent,
  GitHubReactionRecord,
  GitHubRepoRecord,
  GitHubReviewCommentRecord,
} from "../world.ts";
import { type GitHubKit, GitHubRefusal, invalid } from "./kit.ts";
import type { GitHubRepos } from "./repos.ts";

export interface GitHubIssueInput {
  title: string;
  body?: string | undefined;
  labels?: readonly string[] | undefined;
  assignees?: readonly number[] | undefined;
}

export interface GitHubIssueChanges {
  title?: string | undefined;
  body?: string | null | undefined;
  state?: "open" | "closed" | undefined;
  stateReason?: "completed" | "not_planned" | "reopened" | null | undefined;
}

/** Anything a reaction can sit on. */
type Reactable = GitHubIssueRecord | GitHubCommentRecord | GitHubReviewCommentRecord;

/** Issues and the conversation on them: comments, labels, assignees, reactions. A pull request is an issue here too. */
export function createIssues(kit: GitHubKit, repos: GitHubRepos) {
  const { context, store, objects } = kit;
  const { ids, clock } = context;

  const { touch } = kit;

  /** A new issue record with the next number of its repository. Issues and pull requests share the numbers. */
  const newIssue = (
    repo: GitHubRepoRecord,
    author: number,
    title: string,
    body: string | undefined,
  ): GitHubIssueRecord => {
    const now = clock();
    return store.add(store.issues, store.sessionOf(repo), {
      id: Number(ids.next("github.issue")),
      repo: repo.id,
      number: ids.sequence(`github.issue:${repo.id}`),
      title,
      body: body === undefined || body === "" ? null : body,
      author,
      state: "open",
      stateReason: null,
      labels: [],
      assignees: [],
      reactions: [],
      createdAt: now,
      updatedAt: now,
      closedAt: undefined,
      closedBy: undefined,
      pull: undefined,
    });
  };

  /** Add labels to an issue. GitHub creates a label that doesn't exist yet. One `labeled` event per new label. */
  const addLabels = (issue: GitHubIssueRecord, actor: number, names: readonly string[]): Array<string | undefined> => {
    const repo = store.repo(issue.repo);
    const deliveries: Array<string | undefined> = [];
    for (const name of names) {
      const label = repo.labels.get(name.toLowerCase()) ?? repos.addLabel(repo, { name });
      if (issue.labels.some((has) => has.toLowerCase() === label.name.toLowerCase())) continue;
      issue.labels.push(label.name);
      touch(issue);
      deliveries.push(kit.issueEvent(issue, actor, "labeled", { label: objects.label(repo, label) }));
    }
    return deliveries;
  };

  const removeLabels = (
    issue: GitHubIssueRecord,
    actor: number,
    names: readonly string[],
  ): Array<string | undefined> => {
    const repo = store.repo(issue.repo);
    const deliveries: Array<string | undefined> = [];
    for (const name of names) {
      const index = issue.labels.findIndex((has) => has.toLowerCase() === name.toLowerCase());
      const label = repo.labels.get(name.toLowerCase());
      if (index === -1 || !label) throw new GitHubRefusal(404, "Label does not exist");
      issue.labels.splice(index, 1);
      touch(issue);
      deliveries.push(kit.issueEvent(issue, actor, "unlabeled", { label: objects.label(repo, label) }));
    }
    return deliveries;
  };

  const assign = (issue: GitHubIssueRecord, actor: number, assignees: readonly number[]): Array<string | undefined> => {
    const deliveries: Array<string | undefined> = [];
    for (const assignee of assignees) {
      if (issue.assignees.includes(assignee)) continue;
      issue.assignees.push(assignee);
      touch(issue);
      deliveries.push(kit.issueEvent(issue, actor, "assigned", { assignee: objects.actor(assignee) }));
    }
    return deliveries;
  };

  const unassign = (
    issue: GitHubIssueRecord,
    actor: number,
    assignees: readonly number[],
  ): Array<string | undefined> => {
    const deliveries: Array<string | undefined> = [];
    for (const assignee of assignees) {
      if (!issue.assignees.includes(assignee)) continue;
      issue.assignees.splice(issue.assignees.indexOf(assignee), 1);
      touch(issue);
      deliveries.push(kit.issueEvent(issue, actor, "unassigned", { assignee: objects.actor(assignee) }));
    }
    return deliveries;
  };

  return {
    newIssue,
    addLabels,
    removeLabels,
    assign,
    unassign,

    openIssue(
      repo: GitHubRepoRecord,
      actor: number,
      input: GitHubIssueInput,
    ): { issue: GitHubIssueRecord; delivery: string | undefined } {
      if (input.title.trim() === "")
        throw new GitHubRefusal(422, "Validation Failed", [
          { resource: "Issue", code: "missing_field", field: "title" },
        ]);
      const issue = newIssue(repo, actor, input.title, input.body);
      // Labels and assignees given with the issue are on it when `opened` is sent; each still gets its own event after.
      // One label per name, however often and in whatever case it was given.
      const labels = [
        ...new Set(
          (input.labels ?? []).map((name) => repo.labels.get(name.toLowerCase()) ?? repos.addLabel(repo, { name })),
        ),
      ];
      issue.labels.push(...labels.map((label) => label.name));
      issue.assignees.push(...new Set(input.assignees ?? []));
      const delivery = kit.issueEvent(issue, actor, "opened");
      for (const label of labels) kit.issueEvent(issue, actor, "labeled", { label: objects.label(repo, label) });
      for (const assignee of issue.assignees)
        kit.issueEvent(issue, actor, "assigned", { assignee: objects.actor(assignee) });
      return { issue, delivery };
    },

    /**
     * Change an issue's title, body or state. One event per kind of change: `edited` with what
     * the text was before, `closed` or `reopened`. Answers with the last delivery it caused.
     */
    updateIssue(issue: GitHubIssueRecord, actor: number, changes: GitHubIssueChanges): string | undefined {
      // Refused before anything changes.
      if (changes.state === "open" && issue.state !== "open" && issue.pull?.merged) {
        throw invalid("PullRequest", "state", {
          message: "state cannot be changed. The pull request has been merged.",
        });
      }
      let delivery: string | undefined;
      const from: Record<string, { from: string }> = {};
      // No body and an empty body are the same thing.
      const body = changes.body === "" ? null : changes.body;
      if (changes.title !== undefined && changes.title !== issue.title) {
        from.title = { from: issue.title };
        issue.title = changes.title;
      }
      if (body !== undefined && body !== issue.body) {
        from.body = { from: issue.body ?? "" };
        issue.body = body;
      }
      if (Object.keys(from).length > 0) {
        touch(issue);
        delivery = kit.issueEvent(issue, actor, "edited", { changes: from });
      }
      if (changes.state !== undefined && changes.state !== issue.state) {
        issue.state = changes.state;
        issue.closedAt = changes.state === "closed" ? clock() : undefined;
        issue.closedBy = changes.state === "closed" ? actor : undefined;
        issue.stateReason = issue.pull
          ? null
          : changes.state === "closed"
            ? (changes.stateReason ?? "completed")
            : "reopened";
        touch(issue);
        delivery = kit.issueEvent(issue, actor, changes.state === "closed" ? "closed" : "reopened");
      }
      return delivery;
    },

    comment(issue: GitHubIssueRecord, actor: number, body: string): GitHubCommentRecord {
      if (body.trim() === "") {
        throw new GitHubRefusal(422, "Validation Failed", [
          { resource: "IssueComment", code: "unprocessable", field: "data", message: "Body cannot be blank" },
        ]);
      }
      const repo = store.repo(issue.repo);
      const now = clock();
      const comment = store.add(store.comments, store.sessionOf(repo), {
        id: Number(ids.next("github.comment")),
        repo: repo.id,
        issue: issue.number,
        author: actor,
        body,
        reactions: [],
        minimized: undefined,
        createdAt: now,
        updatedAt: now,
        delivery: undefined,
      });
      touch(issue);
      comment.delivery = kit.emit(repo, "issue_comment", actor, {
        action: "created",
        issue: objects.issue(issue),
        comment: objects.comment(comment, issue),
      });
      return comment;
    },

    editComment(comment: GitHubCommentRecord, actor: number, body: string): string | undefined {
      const repo = store.repo(comment.repo);
      const issue = kit.requireIssue(repo, comment.issue);
      const from = comment.body;
      comment.body = body;
      comment.updatedAt = clock();
      return kit.emit(repo, "issue_comment", actor, {
        action: "edited",
        changes: { body: { from } },
        issue: objects.issue(issue),
        comment: objects.comment(comment, issue),
      });
    },

    deleteComment(comment: GitHubCommentRecord, actor: number): string | undefined {
      const repo = store.repo(comment.repo);
      const issue = kit.requireIssue(repo, comment.issue);
      const payload = objects.comment(comment, issue);
      store.forget(store.comments, store.sessionOf(repo), comment.id);
      return kit.emit(repo, "issue_comment", actor, {
        action: "deleted",
        issue: objects.issue(issue),
        comment: payload,
      });
    },

    /** React to an issue or a comment. The same reaction from the same person twice is one reaction, as on GitHub. */
    react(
      target: Reactable,
      actor: number,
      content: GitHubReactionContent,
    ): { reaction: GitHubReactionRecord; created: boolean } {
      const existing = target.reactions.find((reaction) => reaction.user === actor && reaction.content === content);
      if (existing) return { reaction: existing, created: false };
      const reaction = { id: Number(ids.next("github.reaction")), user: actor, content, createdAt: clock() };
      target.reactions.push(reaction);
      return { reaction, created: true };
    },

    unreact(target: Reactable, reactionId: number): void {
      const index = target.reactions.findIndex((reaction) => reaction.id === reactionId);
      if (index === -1) throw new GitHubRefusal(404, "Not Found");
      target.reactions.splice(index, 1);
    },

    /** Hide a comment. GitHub sends nothing about it. */
    minimize(comment: GitHubCommentRecord, reason: GitHubMinimizeReason): void {
      comment.minimized = reason;
    },
  };
}

export type GitHubIssues = ReturnType<typeof createIssues>;
