import { iso } from "../../../core/clock/index.ts";
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
import { connection, matchesFilter, OWNER } from "./graphql.ts";
import type { FakeLinearWorld } from "./world.ts";

type Model = Record<string, unknown> & { id: string; [OWNER]?: string | undefined };
type Args = {
  filter?: Record<string, unknown> | null;
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
  includeArchived?: boolean | null;
};

const maybe = (ms: number | null) => (ms === null ? null : iso(ms));

/** What a GraphQL call needs from its context: which test sessions the objects it reads belong to. */
export interface LinearCallContext {
  sessions: Set<string>;
}

/**
 * Records → the objects GraphQL reads, one builder per Linear type. A relation is a function, so
 * it is only built when an operation asks for it; a field left out gets Linear's empty value.
 * An object carries its test session (`OWNER`): resolving it puts that session on the call's record.
 */
export function linearModels(world: FakeLinearWorld) {
  const { store, links } = world;
  /** A list as a filtered, paged connection. */
  const listOf =
    <T extends Model>(models: readonly T[]) =>
    (args: Args) =>
      connection(
        models.filter((model) => matchesFilter(model, args?.filter)),
        args ?? {},
      );

  const user = (record: LinearUserRecord): Model => ({
    [OWNER]: store.users.owner(record.id),
    __typename: "User",
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    email: record.email,
    admin: record.admin,
    guest: record.guest,
    app: record.app,
    // The fake takes the app's token only, so "me" is always the app's user, in answers and filters alike.
    isMe: record.id === store.appUser.id,
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
    // A new workspace's settings, as Linear sets them up.
    releaseChannel: "public",
    slaDayCount: "all",
    projectUpdatesReminderFrequency: "week",
    projectUpdateRemindersDay: "Friday",
    initiativeUpdateRemindersDay: "Friday",
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

  const teamModel = (record: LinearTeamRecord): Model => {
    const canceled = record.states.find((entry) => entry.type === "canceled");
    const duplicate = record.states.find((entry) => entry.type === "duplicate");
    return {
      [OWNER]: store.teams.owner(record.id),
      __typename: "Team",
      id: record.id,
      key: record.key,
      name: record.name,
      displayName: record.name,
      private: false,
      visibility: "public",
      // Linear picks a new team's color at random: here, from its id.
      color: `#${record.id.replaceAll("-", "").slice(0, 6)}`,
      // A new team's settings, as Linear sets them up: open to everyone, issues closed and archived after six months.
      allMembersCanJoin: true,
      autoClosePeriod: 6,
      autoArchivePeriod: 6,
      // "Defaults to the first canceled state."
      autoCloseStateId: canceled?.id ?? null,
      defaultIssueState: () => state(record, world.defaultStateOf(record)),
      markedAsDuplicateWorkflowState: duplicate ? () => state(record, duplicate) : null,
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

  const issue = (record: LinearIssueRecord): Model => {
    const teamRecord = store.team(record.team);
    const stateRecord = world.stateOf(record);
    const priorityLabel = ["No priority", "Urgent", "High", "Medium", "Low"][record.priority] ?? "No priority";
    const optionalUser = (id: string | null) => (id === null ? null : () => user(store.user(id) as LinearUserRecord));
    return {
      [OWNER]: store.issues.owner(record.id),
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
      // Issues stay in the team they were created in.
      addedToTeamAt: iso(record.createdAt),
      startedAt: maybe(record.startedAt),
      completedAt: maybe(record.completedAt),
      canceledAt: maybe(record.canceledAt),
      // A new workspace counts SLA days as calendar days, and nothing syncs the fake's issues elsewhere.
      slaType: "all",
      syncedWith: [],
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
      [OWNER]: store.comments.owner(record.id),
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
      // A comment Linear wrote (a delegated session's thread) has no user: Linear's workflow wrote it.
      user: record.byLinear ? null : () => user(author),
      botActor: record.byLinear
        ? {
            __typename: "ActorBot",
            id: null,
            type: "workflow",
            subType: null,
            name: "Linear",
            userDisplayName: null,
            avatarUrl: "https://static.linear.app/assets/pwa/icon_maskable_512.png",
          }
        : null,
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

  const session = (record: LinearSessionRecord): Model => {
    const issueRecord = store.issue(record.issue);
    return {
      [OWNER]: store.sessions.owner(record.id),
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
      sourceMetadata: null,
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
      [OWNER]: store.activities.owner(record.id),
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
