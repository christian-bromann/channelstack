/**
 * The GitHub driver's records: what the fake keeps about the org, its people, repos, issues,
 * pull requests, reviews and checks. Ids are numbers, as GitHub's are; the registry keys them as text.
 */

export interface GitHubOrgRecord {
  id: number;
  login: string;
}

/** The agent's GitHub App, installed on the org with access to selected repos. */
export interface GitHubAppRecord {
  /** The App id the agent puts in its JWT. */
  id: number;
  slug: string;
  name: string;
  clientId: string;
  /** The bot user that acts for the App: `<slug>[bot]`. */
  botId: number;
  installationId: number;
  /** The webhook events the App is subscribed to. */
  events: readonly string[];
  permissions: Readonly<Record<string, "read" | "write">>;
  createdAt: number;
}

export type GitHubOrgRole = "member" | "admin" | "outside_collaborator";
/** What someone may do on a repository, from least to most. */
export const PERMISSIONS = ["read", "triage", "write", "maintain", "admin"] as const;

/**
 * A test repository is private unless the test asks otherwise, fake and live: in a real org, what a
 * test writes isn't public. (The differential run found the two worlds disagreeing.)
 */
export const PRIVATE_BY_DEFAULT = true;
export type GitHubPermission = (typeof PERMISSIONS)[number];

export interface GitHubUserRecord {
  id: number;
  login: string;
  name: string | undefined;
  email: string | undefined;
  type: "User" | "Bot";
  role: GitHubOrgRole;
  /** The test fixed this id itself, so it is given back when the session closes. */
  fixedId: boolean;
  createdAt: number;
}

export interface GitHubLabelRecord {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubRepoRecord {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  /** Login → permission. Org admins have admin on every repo without being listed. */
  collaborators: Map<string, GitHubPermission>;
  /** Is the agent's App installed on this repo? It hears about a repo only then. */
  installed: boolean;
  labels: Map<string, GitHubLabelRecord>;
  createdAt: number;
  pushedAt: number;
  updatedAt: number;
}

export const REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;
export type GitHubReactionContent = (typeof REACTIONS)[number];

export interface GitHubReactionRecord {
  id: number;
  user: number;
  content: GitHubReactionContent;
  createdAt: number;
}

/** The pull request half of an issue that is one. */
interface GitHubPullRecord {
  id: number;
  /** Branch names in the same repo. */
  head: string;
  base: string;
  /** Kept once the PR is closed or merged, when the branch may move on or go away. */
  headSha: string;
  baseSha: string;
  draft: boolean;
  merged: boolean;
  mergedAt: number | undefined;
  mergedBy: number | undefined;
  mergeCommitSha: string | undefined;
  requestedReviewers: number[];
  /** What the diff between base and head adds up to, kept current as the head moves. */
  stats: { commits: number; additions: number; deletions: number; changedFiles: number };
}

/** An issue. A pull request is an issue too, with `pull` set. */
export interface GitHubIssueRecord {
  id: number;
  repo: number;
  number: number;
  title: string;
  body: string | null;
  author: number;
  state: "open" | "closed";
  stateReason: "completed" | "reopened" | "not_planned" | null;
  labels: string[];
  assignees: number[];
  reactions: GitHubReactionRecord[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | undefined;
  closedBy: number | undefined;
  pull: GitHubPullRecord | undefined;
}

export type GitHubMinimizeReason = "OUTDATED" | "SPAM" | "OFF_TOPIC" | "RESOLVED";

export interface GitHubCommentRecord {
  id: number;
  repo: number;
  issue: number;
  author: number;
  body: string;
  reactions: GitHubReactionRecord[];
  minimized: GitHubMinimizeReason | undefined;
  createdAt: number;
  updatedAt: number;
  /** The `issue_comment` delivery this comment caused. */
  delivery: string | undefined;
}

export type GitHubReviewState = "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING";

export interface GitHubReviewRecord {
  id: number;
  repo: number;
  pull: number;
  author: number;
  state: GitHubReviewState;
  body: string;
  commitSha: string;
  submittedAt: number | undefined;
  delivery: string | undefined;
}

export interface GitHubReviewCommentRecord {
  id: number;
  repo: number;
  pull: number;
  /** The review it was submitted with. A single comment gets a review of its own, as on GitHub. */
  review: number;
  author: number;
  path: string;
  line: number;
  startLine: number | undefined;
  side: "LEFT" | "RIGHT";
  body: string;
  commitSha: string;
  diffHunk: string;
  /** The thread this comment is in: the id of the comment that started it, which stays the thread's name when that comment is deleted. */
  thread: number;
  /** The comment that started the thread this one replies in. */
  inReplyTo: number | undefined;
  reactions: GitHubReactionRecord[];
  createdAt: number;
  updatedAt: number;
  delivery: string | undefined;
}

export interface GitHubAnnotationRecord {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string | undefined;
  raw_details?: string | undefined;
  start_column?: number | undefined;
  end_column?: number | undefined;
}

export type GitHubCheckConclusion =
  "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";

export interface GitHubCheckRunRecord {
  id: number;
  repo: number;
  suite: number;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: GitHubCheckConclusion | undefined;
  externalId: string;
  detailsUrl: string | undefined;
  startedAt: number;
  completedAt: number | undefined;
  title: string | undefined;
  summary: string | undefined;
  text: string | undefined;
  annotations: GitHubAnnotationRecord[];
  actions: Array<{ label: string; description: string; identifier: string }>;
}

export interface GitHubStatusRecord {
  id: number;
  repo: number;
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string | null;
  targetUrl: string | null;
  creator: number;
  createdAt: number;
}

/** One entry of the App's delivery log (`GET /app/hook/deliveries`). */
export interface GitHubHookDeliveryRecord {
  id: number;
  guid: string;
  session: string;
  event: string;
  action: string | null;
  repo: number | undefined;
  deliveredAt: number;
}

/** A commit as the fake hands it around: what git stores, read back. */
export interface GitHubCommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: number };
  committer: { name: string; email: string; date: number };
}

/** One changed file between two commits. */
export interface GitHubFileChange {
  path: string;
  status: "added" | "modified" | "removed";
  sha: string;
  additions: number;
  deletions: number;
  /** The unified diff's hunks, as GitHub's `patch`. Absent for a binary file. */
  patch: string | undefined;
  /** New-file line numbers a review comment may sit on (side RIGHT), and old-file ones (LEFT). */
  rightLines: number[];
  leftLines: number[];
}
