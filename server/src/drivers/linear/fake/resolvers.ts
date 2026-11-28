import type {
  LinearAppRecord,
  LinearCommentRecord,
  LinearIssueRecord,
  LinearSessionRecord,
  LinearTeamRecord,
} from "../world.ts";
import { LinearError, notFound } from "./graphql.ts";
import { type LinearCallContext, linearModels } from "./models.ts";
import type { FakeLinearWorld } from "./world.ts";

type Args = Record<string, any>;

/**
 * The root of Linear's GraphQL API, as the app whose token made the call sees it: the queries and
 * mutations an agent uses, answered as that app (`viewer`, and the actor of what it writes). Every
 * app is installed workspace-wide, so it reads every team. A root field the fake doesn't serve
 * answers with GraphQL's own error for a missing value. `sync` counts the workspace's changes.
 */
export function linearResolvers(world: FakeLinearWorld, caller: LinearAppRecord, sync: () => number) {
  const { store } = world;
  const viewer = store.appUserOf(caller);
  const models = linearModels(world, viewer);
  const app = () => viewer.id;

  /** An issue by its UUID or its identifier (`ENG-12`), as Linear takes either. */
  const issueBy = (id: string): LinearIssueRecord => {
    const issue = store.issues.find(id) ?? store.all(store.issues).find((candidate) => candidate.identifier === id);
    if (!issue) throw notFound("Issue");
    return issue;
  };
  const teamBy = (id: string): LinearTeamRecord => {
    const team = store.teams.find(id) ?? store.all(store.teams).find((candidate) => candidate.key === id);
    if (!team) throw notFound("Team");
    return team;
  };
  const commentBy = (id: string): LinearCommentRecord => {
    const comment = store.comments.find(id);
    if (!comment) throw notFound("Comment");
    return comment;
  };
  /**
   * A session of the calling app: an app can publish to and update its own sessions only, not
   * another app's (decision 0027; Linear's error for it is to confirm, B4).
   */
  const sessionBy = (id: string): LinearSessionRecord => {
    const session = store.sessions.find(id);
    if (!session) throw notFound("AgentSession");
    if (session.appUser !== app())
      throw new LinearError("You can only publish to your own agent sessions", "FORBIDDEN", "forbidden");
    return session;
  };
  const statesOf = () => store.all(store.teams).flatMap((team) => team.states.map((state) => ({ team, state })));
  const labelsOf = () => store.all(store.teams).flatMap((team) => team.labels.map((label) => ({ team, label })));

  /** A mutation is on record for the session of what it is about, even when it is refused. */
  const mark = (context: LinearCallContext, owner: string | undefined) => {
    if (owner !== undefined) context.sessions.add(owner);
  };

  const Query = {
    viewer: () => models.user(viewer),
    organization: () => models.organization(),
    user: ({ id }: Args) => {
      const user = id === "me" ? viewer : store.user(id);
      if (!user) throw notFound("User");
      return models.user(user);
    },
    users: (args: Args) => models.listOf([...store.appUsers(), ...store.all(store.users)].map(models.user))(args),
    team: ({ id }: Args) => models.team(teamBy(id)),
    teams: (args: Args) => models.listOf(store.all(store.teams).map((team) => models.team(team)))(args),
    issue: ({ id }: Args) => models.issue(issueBy(id)),
    issues: (args: Args) => models.listOf(store.all(store.issues).map((issue) => models.issue(issue)))(args),
    comment: ({ id }: Args) => models.comment(commentBy(id)),
    comments: (args: Args) => models.listOf(store.all(store.comments).map(models.comment))(args),
    agentSession: ({ id }: Args) => {
      const session = store.sessions.find(id);
      if (!session) throw notFound("AgentSession");
      return models.session(session);
    },
    agentSessions: (args: Args) =>
      models.listOf(
        store
          .all(store.sessions)
          .filter((session) => session.appUser === app())
          .map((session) => models.session(session)),
      )(args),
    agentActivity: ({ id }: Args) => {
      const activity = store.activities.find(id);
      if (!activity) throw notFound("AgentActivity");
      return models.activity(activity);
    },
    agentActivities: (args: Args) => models.listOf(store.all(store.activities).map(models.activity))(args),
    workflowState: ({ id }: Args) => {
      const found = statesOf().find(({ state }) => state.id === id);
      if (!found) throw notFound("WorkflowState");
      return models.state(found.team, found.state);
    },
    workflowStates: (args: Args) => models.listOf(statesOf().map(({ team, state }) => models.state(team, state)))(args),
    issueLabel: ({ id }: Args) => {
      const found = labelsOf().find(({ label }) => label.id === id);
      if (!found) throw notFound("IssueLabel");
      return models.label(found.team, found.label);
    },
    issueLabels: (args: Args) => models.listOf(labelsOf().map(({ team, label }) => models.label(team, label)))(args),
  };

  const Mutation = {
    agentActivityCreate: ({ input }: Args, context: LinearCallContext) => {
      const session = sessionBy(input.agentSessionId);
      mark(context, store.sessions.owner(session.id));
      const activity = world.publish(session, input);
      return { lastSyncId: sync(), success: true, agentActivity: () => models.activity(activity) };
    },
    agentSessionUpdate: ({ id, input }: Args, context: LinearCallContext) => {
      const session = sessionBy(id);
      mark(context, store.sessions.owner(session.id));
      world.updateSession(session, input);
      return { lastSyncId: sync(), success: true, agentSession: () => models.session(session) };
    },
    issueUpdate: ({ id, input }: Args, context: LinearCallContext) => {
      const issue = issueBy(id);
      mark(context, store.issues.owner(issue.id));
      const labelIds =
        input.labelIds ??
        (input.addedLabelIds || input.removedLabelIds
          ? [
              ...issue.labels.filter((label) => !(input.removedLabelIds ?? []).includes(label)),
              ...(input.addedLabelIds ?? []),
            ]
          : undefined);
      world.updateIssue(issue, app(), {
        ...input,
        labelIds: labelIds === undefined ? undefined : [...new Set(labelIds as string[])],
      });
      return { lastSyncId: sync(), success: true, issue: () => models.issue(issue) };
    },
    issueAddLabel: ({ id, labelId }: Args, context: LinearCallContext) => {
      const issue = issueBy(id);
      mark(context, store.issues.owner(issue.id));
      world.updateIssue(issue, app(), { labelIds: [...new Set([...issue.labels, labelId as string])] });
      return { lastSyncId: sync(), success: true, issue: () => models.issue(issue) };
    },
    issueRemoveLabel: ({ id, labelId }: Args, context: LinearCallContext) => {
      const issue = issueBy(id);
      mark(context, store.issues.owner(issue.id));
      world.updateIssue(issue, app(), { labelIds: issue.labels.filter((label) => label !== labelId) });
      return { lastSyncId: sync(), success: true, issue: () => models.issue(issue) };
    },
    commentCreate: ({ input }: Args, context: LinearCallContext) => {
      if (typeof input.body !== "string") throw new LinearError("body is required");
      const parent = input.parentId ? commentBy(input.parentId) : undefined;
      const issue = input.issueId ? issueBy(input.issueId) : parent ? store.issue(parent.issue) : undefined;
      if (!issue) throw new LinearError("A comment needs an issueId or a parentId");
      mark(context, store.issues.owner(issue.id));
      const comment = world.comment(issue, app(), input.body, parent);
      return { lastSyncId: sync(), success: true, comment: () => models.comment(comment) };
    },
    commentUpdate: ({ id, input }: Args, context: LinearCallContext) => {
      const comment = commentBy(id);
      mark(context, store.comments.owner(comment.id));
      // Linear's own comment (a delegated session's thread) isn't the app's, though the fake files it under the app.
      if (comment.user !== app() || comment.byLinear)
        throw new LinearError("You can only edit your own comments", "FORBIDDEN", "forbidden");
      if (typeof input.body === "string") world.editComment(comment, app(), input.body);
      return { lastSyncId: sync(), success: true, comment: () => models.comment(comment) };
    },
    commentDelete: ({ id }: Args, context: LinearCallContext) => {
      const comment = commentBy(id);
      mark(context, store.comments.owner(comment.id));
      // Linear's own comment (a delegated session's thread) isn't the app's, though the fake files it under the app.
      if (comment.user !== app() || comment.byLinear)
        throw new LinearError("You can only delete your own comments", "FORBIDDEN", "forbidden");
      world.deleteComment(comment, app());
      return { lastSyncId: sync(), success: true, entityId: id };
    },
    reactionCreate: ({ input }: Args, context: LinearCallContext) => {
      const comment = input.commentId ? commentBy(input.commentId) : undefined;
      if (!comment) throw new LinearError("The fake takes reactions on comments only");
      mark(context, store.comments.owner(comment.id));
      world.react(comment, app(), input.emoji);
      const reaction = comment.reactions.find((entry) => entry.user === app() && entry.emoji === input.emoji);
      return {
        lastSyncId: sync(),
        success: true,
        reaction: () => ({ ...reaction, createdAt: new Date(reaction?.createdAt ?? 0).toISOString() }),
      };
    },
  };

  return { Query, Mutation };
}
