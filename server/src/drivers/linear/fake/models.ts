import {
  type LinearActivityRecord,
  type LinearCommentRecord,
  type LinearIssueRecord,
  type LinearLabelRecord,
  type LinearSessionRecord,
  type LinearStateRecord,
  type LinearTeamRecord,
  type LinearUserRecord,
  reactionData,
} from "../world.ts";
import { connection, matchesFilter } from "./graphql.ts";
import type { FakeLinearWorld } from "./world.ts";

type Model = Record<string, unknown> & { id: string };
type Args = {
  filter?: Record<string, unknown> | null;
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
  includeArchived?: boolean | null;
};

const iso = (ms: number) => new Date(ms).toISOString();
const maybe = (ms: number | null) => (ms === null ? null : iso(ms));

/** What a GraphQL call needs from its context: which test sessions the objects it reads belong to. */
export interface LinearCallContext {
  sessions: Set<string>;
}

/**
 * Records → the objects GraphQL reads, one builder per Linear type. A relation is a function, so
 * it is only built when an operation asks for it; a field left out gets Linear's empty value.
 * Reading an object puts its test session on the call's record.
 */
export function linearModels(world: FakeLinearWorld) {
  const { store, links } = world;
  const touch = (context: LinearCallContext | undefined, session: string | undefined) => {
    if (context && session !== undefined) context.sessions.add(session);
  };
  /** A list as a filtered, paged connection. */
  const listOf =
    <T extends Model>(models: readonly T[]) =>
    (args: Args) =>
      connection(
        models.filter((model) => matchesFilter(model, args?.filter)),
        args ?? {},
      );

  const user = (record: LinearUserRecord): Model => ({
    __typename: "User",
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    email: record.email,
    admin: record.admin,
    guest: record.guest,
    app: record.app,
    isMe: (_: unknown, context: { viewer?: string } | undefined) => context?.viewer === record.id,
    active: true,
    url: links.profile(record),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.createdAt),
    timezone: "Europe/Berlin",
    initials: record.name.slice(0, 2).toUpperCase(),
    avatarBackgroundColor: "#5e6ad2",
    organization: () => organization(),
    teams: (args: Args) =>
      listOf(
        store
          .all(store.teams)
          .filter((team) => team.members.includes(record.id) || record.app)
          .map(team),
      )(args),
    assignedIssues: (args: Args) =>
      listOf(
        store
          .all(store.issues)
          .filter((entry) => entry.assignee === record.id)
          .map((entry) => issue(entry)),
      )(args),
    delegatedIssues: (args: Args) =>
      listOf(
        store
          .all(store.issues)
          .filter((entry) => entry.delegate === record.id)
          .map((entry) => issue(entry)),
      )(args),
  });

  const organization = (): Model => ({
    __typename: "Organization",
    id: store.org.id,
    name: store.org.name,
    urlKey: store.org.urlKey,
    createdAt: iso(store.app.createdAt),
    updatedAt: iso(store.app.createdAt),
    userCount: store.all(store.users).length + 1,
    users: (args: Args) => listOf([store.appUser, ...store.all(store.users)].map(user))(args),
    teams: (args: Args) => listOf(store.all(store.teams).map(team))(args),
  });

  const state = (team: LinearTeamRecord, record: LinearStateRecord): Model => ({
    __typename: "WorkflowState",
    id: record.id,
    name: record.name,
    type: record.type,
    color: record.color,
    position: record.position,
    description: null,
    createdAt: iso(team.createdAt),
    updatedAt: iso(team.createdAt),
    team: () => teamModel(team),
  });

  const label = (team: LinearTeamRecord, record: LinearLabelRecord): Model => ({
    __typename: "IssueLabel",
    id: record.id,
    name: record.name,
    color: record.color,
    description: null,
    isGroup: false,
    createdAt: iso(team.createdAt),
    updatedAt: iso(team.createdAt),
    team: () => teamModel(team),
  });

  const teamModel = (record: LinearTeamRecord, context?: LinearCallContext): Model => {
    touch(context, store.teams.owner(record.id));
    return {
      __typename: "Team",
      id: record.id,
      key: record.key,
      name: record.name,
      displayName: record.name,
      private: false,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.createdAt),
      organization: () => organization(),
      states: (args: Args) => listOf(record.states.map((entry) => state(record, entry)))(args),
      labels: (args: Args) => listOf(record.labels.map((entry) => label(record, entry)))(args),
      members: (args: Args) => listOf(record.members.flatMap((id) => store.user(id) ?? []).map(user))(args),
      issues: (args: Args) => listOf(store.issuesOf(record).map((entry) => issue(entry)))(args),
    };
  };
  const team = (record: LinearTeamRecord) => teamModel(record);

  const issue = (record: LinearIssueRecord, context?: LinearCallContext): Model => {
    touch(context, store.issues.owner(record.id));
    const teamRecord = store.team(record.team);
    const stateRecord = world.stateOf(record);
    const priorityLabel = ["No priority", "Urgent", "High", "Medium", "Low"][record.priority] ?? "No priority";
    const optionalUser = (id: string | null) => (id === null ? null : () => user(store.user(id) as LinearUserRecord));
    return {
      __typename: "Issue",
      id: record.id,
      identifier: record.identifier,
      number: record.number,
      title: record.title,
      description: record.description,
      priority: record.priority,
      priorityLabel,
      prioritySortOrder: record.number,
      sortOrder: record.number,
      boardOrder: record.number,
      url: links.issue(record),
      branchName: `${record.identifier.toLowerCase()}-${record.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)}`.replace(/-$/, ""),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      startedAt: maybe(record.startedAt),
      completedAt: maybe(record.completedAt),
      canceledAt: maybe(record.canceledAt),
      labelIds: [...record.labels],
      previousIdentifiers: [],
      reactionData: [],
      customerTicketCount: 0,
      // Issues aren't shared outside their team in the fake.
      sharedAccess: {
        __typename: "IssueSharedAccess",
        isShared: false,
        sharedWithCount: 0,
        sharedWithUsers: [],
        viewerHasOnlySharedAccess: false,
        disallowedIssueFields: [],
      },
      team: () => teamModel(teamRecord),
      state: () => state(teamRecord, stateRecord),
      assignee: optionalUser(record.assignee),
      delegate: optionalUser(record.delegate),
      creator: optionalUser(record.creator),
      parent: record.parent === null ? null : () => issue(store.issue(record.parent as string)),
      labels: (args: Args) =>
        listOf(
          teamRecord.labels
            .filter((entry) => record.labels.includes(entry.id))
            .map((entry) => label(teamRecord, entry)),
        )(args),
      comments: (args: Args) => listOf(store.commentsOn(record).map(comment))(args),
      children: (args: Args) =>
        listOf(
          store
            .issuesOf(teamRecord)
            .filter((entry) => entry.parent === record.id)
            .map((entry) => issue(entry)),
        )(args),
      subscribers: (args: Args) => listOf([user(store.user(record.creator) as LinearUserRecord)])(args),
    };
  };

  const comment = (record: LinearCommentRecord): Model => {
    const issueRecord = store.issue(record.issue);
    const author = store.user(record.user) as LinearUserRecord;
    return {
      __typename: "Comment",
      id: record.id,
      body: record.body,
      url: links.comment(issueRecord, record.id),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      editedAt: maybe(record.editedAt),
      reactionData: reactionData(record.reactions),
      issueId: issueRecord.id,
      parentId: record.parent,
      user: () => user(author),
      botActor: null,
      issue: () => issue(issueRecord),
      parent:
        record.parent === null
          ? null
          : () => {
              const parent = store.comments.find(record.parent as string);
              return parent ? comment(parent) : null;
            },
      children: (args: Args) =>
        listOf(
          store
            .commentsOn(issueRecord)
            .filter((entry) => entry.parent === record.id)
            .map(comment),
        )(args),
      agentSession: () => {
        const owned = store.sessionsOn(issueRecord).find((entry) => entry.thread === world.rootOf(record).id);
        return owned ? session(owned) : null;
      },
      reactions: () =>
        record.reactions.map((reaction) => ({
          __typename: "Reaction",
          id: reaction.id,
          emoji: reaction.emoji,
          createdAt: iso(reaction.createdAt),
          updatedAt: iso(reaction.createdAt),
          user: () => user(store.user(reaction.user) as LinearUserRecord),
        })),
    };
  };

  const session = (record: LinearSessionRecord, context?: LinearCallContext): Model => {
    touch(context, store.sessions.owner(record.id));
    const issueRecord = store.issue(record.issue);
    return {
      __typename: "AgentSession",
      id: record.id,
      status: record.status,
      type: "commentThread",
      slugId: record.slugId,
      summary: record.summary,
      url: links.session(issueRecord, record.slugId),
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      startedAt: maybe(record.startedAt),
      endedAt: maybe(record.endedAt),
      context: [],
      plan: record.plan ? { entries: record.plan.entries, updatedAt: iso(record.plan.updatedAt) } : null,
      externalUrls: JSON.stringify(record.externalUrls),
      externalLinks: record.externalUrls.map((link) => ({ __typename: "AgentSessionExternalLink", ...link })),
      externalLink: record.externalUrls[0]?.url ?? null,
      appUser: () => user(store.appUser),
      creator: () => user(store.user(record.creator) as LinearUserRecord),
      issue: () => issue(issueRecord),
      comment:
        record.comment === null
          ? null
          : () => {
              const root = store.comments.find(record.comment as string);
              return root ? comment(root) : null;
            },
      sourceComment: null,
      activities: (args: Args) => listOf(store.activitiesOf(record).map(activity))(args),
    };
  };

  const activity = (record: LinearActivityRecord): Model => {
    const sessionRecord = store.sessions.find(record.session) as LinearSessionRecord;
    const typename = `AgentActivity${record.content.type.charAt(0).toUpperCase()}${record.content.type.slice(1)}Content`;
    return {
      __typename: "AgentActivity",
      id: record.id,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.createdAt),
      ephemeral: record.ephemeral,
      signal: record.signal,
      signalMetadata: record.signalMetadata,
      sourceMetadata: null,
      content: { __typename: typename, ...record.content, result: record.content.result ?? null },
      agentSession: () => session(sessionRecord),
      user: () => user(store.user(record.user) as LinearUserRecord),
      promptAuthor: record.content.type === "prompt" ? () => user(store.user(record.user) as LinearUserRecord) : null,
      sourceComment:
        record.sourceComment === null
          ? null
          : () => {
              const source = store.comments.find(record.sourceComment as string);
              return source ? comment(source) : null;
            },
    };
  };

  return { user, organization, state, label, team: teamModel, issue, comment, session, activity, listOf };
}
