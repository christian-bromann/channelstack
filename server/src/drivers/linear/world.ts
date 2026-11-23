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

export type LinearStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage";

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
  /** The root comment of the session's thread, when it has one. */
  comment: string | null;
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
