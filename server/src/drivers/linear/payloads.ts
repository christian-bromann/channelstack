import type { LinearLinks } from "./links.ts";
import {
  type LinearActivityRecord,
  type LinearCommentRecord,
  type LinearIssueRecord,
  type LinearSessionRecord,
  type LinearStateRecord,
  type LinearTeamRecord,
  type LinearUserRecord,
  reactionData,
} from "./world.ts";

type Json = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const maybe = (ms: number | null) => (ms === null ? null : iso(ms));

/** What the builders need beyond the record they are given. */
export interface LinearLookups {
  links: LinearLinks;
  user(id: string): LinearUserRecord;
  team(id: string): LinearTeamRecord;
  issue(id: string): LinearIssueRecord;
  comment(id: string): LinearCommentRecord | undefined;
  state(issue: LinearIssueRecord): LinearStateRecord;
}

/**
 * Builders for what Linear's webhooks carry. Each one is the shape of a `…WebhookPayload` type in
 * Linear's schema, which the tests hold them to (exit check 4.3).
 */
export function linearPayloads(lookups: LinearLookups) {
  const { links } = lookups;

  const userChild = (record: LinearUserRecord): Json => ({
    id: record.id,
    name: record.name,
    email: record.email,
    url: links.profile(record),
    avatarUrl: null,
  });

  const teamChild = (record: LinearTeamRecord): Json => ({ id: record.id, key: record.key, name: record.name });

  const issueChild = (record: LinearIssueRecord, withDescription = false): Json => ({
    id: record.id,
    identifier: record.identifier,
    title: record.title,
    url: links.issue(record),
    teamId: record.team,
    team: teamChild(lookups.team(record.team)),
    ...(withDescription ? { description: record.description } : {}),
  });

  const commentChild = (record: LinearCommentRecord): Json => ({
    id: record.id,
    body: record.body,
    issueId: record.issue,
    userId: record.user,
  });

  const priorityLabel = (priority: number) =>
    ["No priority", "Urgent", "High", "Medium", "Low"][priority] ?? "No priority";

  /** `data` of an `Issue` event. */
  const issue = (record: LinearIssueRecord): Json => {
    const team = lookups.team(record.team);
    const state = lookups.state(record);
    return {
      id: record.id,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      number: record.number,
      identifier: record.identifier,
      title: record.title,
      description: record.description,
      priority: record.priority,
      priorityLabel: priorityLabel(record.priority),
      prioritySortOrder: record.number,
      sortOrder: record.number,
      url: links.issue(record),
      teamId: team.id,
      team: teamChild(team),
      stateId: state.id,
      state: { id: state.id, name: state.name, type: state.type, color: state.color },
      labelIds: [...record.labels],
      labels: team.labels
        .filter((label) => record.labels.includes(label.id))
        .map((label) => ({ id: label.id, name: label.name, color: label.color, parentId: null })),
      assigneeId: record.assignee,
      ...(record.assignee ? { assignee: userChild(lookups.user(record.assignee)) } : {}),
      delegateId: record.delegate,
      ...(record.delegate ? { delegate: userChild(lookups.user(record.delegate)) } : {}),
      creatorId: record.creator,
      parentId: record.parent,
      startedAt: maybe(record.startedAt),
      completedAt: maybe(record.completedAt),
      canceledAt: maybe(record.canceledAt),
      previousIdentifiers: [],
      subscriberIds: [record.creator],
      reactionData: [],
      releases: [],
    };
  };

  /** `data` of a `Comment` event. */
  const comment = (record: LinearCommentRecord): Json => {
    const parent = record.parent ? lookups.comment(record.parent) : undefined;
    return {
      id: record.id,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      editedAt: maybe(record.editedAt),
      body: record.body,
      issueId: record.issue,
      issue: issueChild(lookups.issue(record.issue)),
      parentId: record.parent,
      ...(parent ? { parent: commentChild(parent) } : {}),
      userId: record.user,
      user: userChild(lookups.user(record.user)),
      reactionData: reactionData(record.reactions),
    };
  };

  const session = (record: LinearSessionRecord, organizationId: string): Json => {
    const issueRecord = lookups.issue(record.issue);
    const root = record.comment ? lookups.comment(record.comment) : undefined;
    return {
      id: record.id,
      type: "commentThread",
      status: record.status,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      startedAt: maybe(record.startedAt),
      endedAt: maybe(record.endedAt),
      organizationId,
      appUserId: record.appUser,
      creatorId: record.creator,
      creator: userChild(lookups.user(record.creator)),
      issueId: issueRecord.id,
      issue: issueChild(issueRecord, true),
      commentId: record.comment,
      ...(root ? { comment: commentChild(root) } : {}),
      sourceCommentId: record.sourceComment ?? null,
      archivedAt: null,
      summary: record.summary,
      url: links.session(issueRecord, record.slugId),
    };
  };

  const activity = (record: LinearActivityRecord): Json => ({
    id: record.id,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.createdAt),
    agentSessionId: record.session,
    content: record.content,
    signal: record.signal,
    ...(record.signalMetadata ? { signalMetadata: record.signalMetadata } : {}),
    sourceCommentId: record.sourceComment,
    userId: record.user,
    user: userChild(lookups.user(record.user)),
  });

  /** Whoever did it, as an entity event's `actor`. */
  const actor = (record: LinearUserRecord): Json => ({
    id: record.id,
    type: "user",
    name: record.name,
    email: record.email,
    url: links.profile(record),
  });

  return { userChild, issueChild, commentChild, issue, comment, session, activity, actor };
}
