/**
 * The Linear driver's records: what the fake keeps about the workspace, its people, teams,
 * issues, comments and agent sessions. Ids are UUIDs, as Linear's are.
 */

export interface LinearOrgRecord {
  id: string;
  name: string;
  /** The workspace's part of every URL: `https://linear.localhost/acme/…`. */
  urlKey: string;
}

/** The agent's OAuth app, installed workspace-wide with its own app user. */
export interface LinearAppRecord {
  /** The app user that acts for the app (`viewer` for its token). */
  userId: string;
  name: string;
  /** The webhook events the app is subscribed to (Linear's resource types). */
  events: readonly string[];
  /** The app's webhook: every delivery names it (`webhookId`). */
  webhookId: string;
  createdAt: number;
}

export interface LinearUserRecord {
  id: string;
  name: string;
  displayName: string;
  email: string;
  admin: boolean;
  guest: boolean;
  /** The app's own user. */
  app: boolean;
  fixedId: boolean;
  createdAt: number;
}

/**
 * A workflow state's type, as Linear's schema lists them. `duplicate` is Linear's own: every team
 * has one Duplicate state, and none can be created (`workflowStateCreate` refuses the type).
 */
export type LinearStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage" | "duplicate";

export interface LinearStateRecord {
  id: string;
  name: string;
  type: LinearStateType;
  color: string;
  position: number;
}

export interface LinearLabelRecord {
  id: string;
  name: string;
  color: string;
}

export interface LinearTeamRecord {
  id: string;
  key: string;
  name: string;
  members: string[];
  states: LinearStateRecord[];
  labels: LinearLabelRecord[];
  createdAt: number;
}

export interface LinearIssueRecord {
  id: string;
  team: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: string;
  labels: string[];
  assignee: string | null;
  delegate: string | null;
  creator: string;
  parent: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  canceledAt: number | null;
}

export interface LinearReactionRecord {
  id: string;
  emoji: string;
  user: string;
  createdAt: number;
}

/** A comment's `reactionData`: its reactions grouped by emoji, as Linear sends them. */
export function reactionData(reactions: LinearReactionRecord[]) {
  const groups = new Map<string, Array<{ id: string; userId: string; reactedAt: string }>>();
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? [];
    group.push({ id: reaction.id, userId: reaction.user, reactedAt: new Date(reaction.createdAt).toISOString() });
    groups.set(reaction.emoji, group);
  }
  return [...groups].map(([emoji, group]) => ({ emoji, reactions: group }));
}

export interface LinearCommentRecord {
  id: string;
  issue: string;
  user: string;
  body: string;
  /** The comment that started the thread this one replies in. */
  parent: string | null;
  reactions: LinearReactionRecord[];
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  /** The agent session this comment opened, or whose thread it is in. */
  session: string | undefined;
  /** The `Comment` delivery this comment caused. */
  delivery: string | undefined;
  /**
   * Written by Linear itself: the comment that opens a delegated session's thread. It has no user
   * and Linear's workflow as its `botActor`; `user` is then the app's, whose session it opens, as
   * the live mirror reads every comment without a user.
   */
  byLinear?: boolean;
  /** For a reply in a session's thread: the `AgentSessionEvent` (`prompted`) delivery it caused. */
  prompted: string | undefined;
}

/** A session's status, as Linear's `AgentSessionStatus` has it. */
type LinearSessionStatus = "pending" | "active" | "stopping" | "awaitingInput" | "complete" | "error" | "stale";

export interface LinearPlanEntry {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearSessionRecord {
  id: string;
  issue: string;
  appUser: string;
  /** The person responsible for the session: whoever delegated or mentioned the app. */
  creator: string;
  /** The comment that opened the session (a mention, or Linear's own for a delegation), as `AgentSession.comment`. */
  comment: string | null;
  /**
   * The root comment of the thread the session's comments are in: the mention, or for a
   * delegation the comment Linear writes to open it. A reply there prompts the session. Null
   * only live, for a session whose thread the mirror hasn't read.
   */
  thread: string | null;
  status: LinearSessionStatus;
  plan: { entries: LinearPlanEntry[]; updatedAt: number } | null;
  externalUrls: Array<{ label: string; url: string }>;
  summary: string | null;
  slugId: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** The `AgentSessionEvent` (`created`) delivery that opened it. */
  delivery: string | undefined;
}

export type LinearActivityType = "thought" | "action" | "elicitation" | "response" | "error" | "prompt";

export interface LinearActivityRecord {
  id: string;
  session: string;
  /** Who it is from: the app user, or the person who prompted. */
  user: string;
  content: {
    type: LinearActivityType;
    body?: string;
    action?: string;
    parameter?: string;
    result?: string | null;
    reason?: string | null;
  };
  ephemeral: boolean;
  signal: "auth" | "continue" | "select" | "stop" | null;
  signalMetadata: Record<string, unknown> | null;
  /** The comment a person wrote this prompt as, or the app's comment that shows this activity. */
  sourceComment: string | null;
  createdAt: number;
}

/** An issue as a person or the app creates it: names for state and labels, ids for people. */
export interface LinearIssueInput {
  title: string;
  description?: string | undefined;
  priority?: number | undefined;
  state?: string | undefined;
  labels?: readonly string[] | undefined;
  assignee?: string | undefined;
  delegate?: string | undefined;
  parent?: string | undefined;
}

/** A change to an issue, as `issueUpdate` takes it. */
export interface LinearIssueChanges {
  title?: string | undefined;
  description?: string | null | undefined;
  priority?: number | undefined;
  stateId?: string | undefined;
  labelIds?: readonly string[] | undefined;
  assigneeId?: string | null | undefined;
  delegateId?: string | null | undefined;
}
