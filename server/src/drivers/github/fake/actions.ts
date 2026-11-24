import type { GitHubWorld } from "../backend.ts";
import type { GitHubIssueRecord } from "../world.ts";
import type { FakeGitHubWorld } from "./world.ts";

/**
 * The fake's `GitHubWorld`: each action over the fake's parts, with the permission check real
 * GitHub makes itself (404 for a repository a person can't see, 403 for one they can't change).
 */
export function fakeGitHubWorld(world: FakeGitHubWorld): GitHubWorld {
  const { kit, repos, issues } = world;
  const { store } = kit;
  /** May this person change an issue someone else opened? Its author always may. */
  const mayChange = (issue: GitHubIssueRecord, actor: number) =>
    kit.allow(store.repo(issue.repo), actor, issue.author === actor ? "read" : "triage");

  return {
    store,
    repoWeb: (repo) => kit.objects.repoWeb(repo),
    createUser: (session, input) => repos.createUser(session, input),
    createRepo: (session, input) => repos.createRepo(session, input),
    readFile: (repo, path, ref) => repos.readFile(repo, path, ref),

    openIssue(repo, actor, input) {
      kit.allow(repo, actor, "read");
      // Only people who can triage may label and assign; from anyone else GitHub drops both silently.
      const triage = kit.can(repo, actor, "triage");
      return issues.openIssue(repo, actor, {
        title: input.title,
        body: input.body,
        labels: triage ? input.labels : [],
        assignees: triage ? input.assignees : [],
      }).issue;
    },
    updateIssue(issue, actor, changes) {
      mayChange(issue, actor);
      return issues.updateIssue(issue, actor, changes);
    },
    label(issue, actor, labels, add) {
      kit.allow(store.repo(issue.repo), actor, "triage");
      return add ? issues.addLabels(issue, actor, labels) : issues.removeLabels(issue, actor, labels);
    },
    assign(issue, actor, assignees) {
      kit.allow(store.repo(issue.repo), actor, "triage");
      return issues.assign(issue, actor, assignees);
    },
    comment(issue, actor, body) {
      kit.allow(store.repo(issue.repo), actor, "read");
      return issues.comment(issue, actor, body);
    },
    editComment(comment, actor, body) {
      // GitHub lets you edit your own comment; someone else's needs write access.
      kit.allow(store.repo(comment.repo), actor, comment.author === actor ? "read" : "write");
      return issues.editComment(comment, actor, body);
    },
    deleteComment(comment, actor) {
      kit.allow(store.repo(comment.repo), actor, comment.author === actor ? "read" : "write");
      return issues.deleteComment(comment, actor);
    },
    react(target, actor, content) {
      kit.allow(store.repo(target.repo), actor, "read");
      issues.react(target, actor, content);
    },
    /** The fake holds the truth already: there is nothing to read again. */
    refresh: () => {},

    deliveries: (session) => world.deliveries(session),
    delivery: (session, guid) => world.delivery(session, guid),
    redeliver: (session, guid) => world.redeliver(session, guid),
  };
}
