import type {
  App, Delivery, DeliveryAttempt, FileInput, HasTranscript, Inspectable, QuietOptions,
  Resource, RichText, Timestamp, User, WaitOptions,
} from "./common";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The `github` test fixture: one in-memory organization. */
export interface GitHubFixture extends Inspectable<GitHubDelivery> {
  /** The agent's GitHub App from `channelstack.config.ts`. Install it on repos explicitly. */
  readonly app: GitHubApp;
  /** Base URL to give the agent (Octokit `baseUrl`), e.g. `https://github.localhost`. */
  readonly apiUrl: string;
  readonly org: string;

  createUser(options: GitHubUserOptions): Promise<GitHubUser>;

  /**
   * Create a repository in the org. The app only receives webhooks for it when it's
   * listed in `apps` (GitHub's real rule: the App must be installed on the repo).
   */
  createRepo(options: GitHubRepoOptions): Promise<GitHubRepo>;
}

export interface GitHubUserOptions {
  login: string;
  /** Fixed numeric id, for agents that allowlist by id. */
  id?: number;
  name?: string;
  email?: string;
  /** Org role. Default "member". */
  role?: "member" | "admin" | "outside_collaborator";
  /** A real machine user (fine-grained PAT) in a live org. Also read from `CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN`. */
  token?: string;
}

export interface GitHubRepoOptions {
  /** Repository name without owner. Generated (`test-<id>`) if omitted. */
  name?: string;
  private?: boolean;
  defaultBranch?: string;
  /** Initial contents of the default branch: a fixture directory or a list of files. */
  files?: string | FileInput[];
  collaborators?: Array<GitHubUser | { user: GitHubUser; permission: "read" | "triage" | "write" | "maintain" | "admin" }>;
  /** Apps installed on this repo. */
  apps?: GitHubApp[];
  labels?: Array<string | { name: string; color?: string; description?: string }>;
}

/** File changes: a list of files, or a map of path to new contents (`null` deletes). */
export type GitHubChanges = FileInput[] | Record<string, string | null>;

export type GitHubReaction = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

// ---------------------------------------------------------------------------
// People: every action a person takes lives here
// ---------------------------------------------------------------------------

/**
 * A person in the org. Content first, where it happens as an option:
 * `ana.comment("@my-agent fix this", { issue: pr })`, `ben.review({ pr, event: "APPROVE" })`.
 * A pull request is also an issue, so `{ issue }` accepts either.
 */
export interface GitHubUser extends User {
  readonly channel: "github";
  readonly login: string;
  readonly numericId: number;

  // ------------------------------------------------------------ code
  /** Push a commit to a branch (created from the default branch if missing). Sends `push`, and `pull_request` `synchronize` for open PRs on it. */
  push(changes: GitHubChanges, where: { repo: GitHubRepo; branch: string; message?: string }): Promise<GitHubCommit>;

  // ------------------------------------------------------------ issues and PRs
  openIssue(issue: { title: string; body?: RichText; labels?: string[]; assignees?: GitHubAuthor[] }, where: { repo: GitHubRepo }): Promise<GitHubIssue>;
  /** Open a pull request. Pass `changes` to push them to `from` first, or point `from` at an existing branch. */
  openPullRequest(pr: {
    from: string;
    to?: string;
    title?: string;
    body?: RichText;
    changes?: GitHubChanges;
    draft?: boolean;
    reviewers?: GitHubAuthor[];
  }, where: { repo: GitHubRepo }): Promise<GitHubPullRequest>;
  editIssue(changes: { title?: string; body?: RichText }, target: { issue: GitHubIssue }): Promise<GitHubDelivery>;
  close(target: { issue: GitHubIssue }): Promise<GitHubDelivery>;
  reopen(target: { issue: GitHubIssue }): Promise<GitHubDelivery>;
  label(labels: string | string[], target: { issue: GitHubIssue }): Promise<GitHubDelivery[]>;
  unlabel(labels: string | string[], target: { issue: GitHubIssue }): Promise<GitHubDelivery[]>;
  /** Assign people or the app's bot. Sends `issues`/`pull_request` (action `assigned`). */
  assign(assignees: GitHubAuthor | GitHubAuthor[], target: { issue: GitHubIssue }): Promise<GitHubDelivery[]>;

  // ------------------------------------------------------------ conversation
  /** Comment on an issue or PR conversation. Sends `issue_comment` (action `created`). */
  comment(body: RichText, where: { issue: GitHubIssue }): Promise<GitHubComment>;
  /** Edit a conversation comment or review comment. */
  edit(body: RichText, target: { comment: GitHubComment | GitHubReviewComment }): Promise<GitHubDelivery>;
  delete(target: { comment: GitHubComment | GitHubReviewComment }): Promise<GitHubDelivery>;
  react(content: GitHubReaction, target: { issue: GitHubIssue } | { comment: GitHubComment | GitHubReviewComment }): Promise<void>;
  /** Hide a comment as outdated, spam, off-topic and so on. */
  minimize(target: { comment: GitHubComment; reason?: "OUTDATED" | "SPAM" | "OFF_TOPIC" | "RESOLVED" }): Promise<void>;

  // ------------------------------------------------------------ reviews
  /** Submit a review, optionally with inline comments. Sends `pull_request_review` and one `pull_request_review_comment` per inline comment. */
  review(review: {
    pr: GitHubPullRequest;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    body?: RichText;
    comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; startLine?: number; body: RichText }>;
  }): Promise<GitHubReview>;
  /** A single inline comment on the diff, outside a review. */
  reviewComment(body: RichText, where: { pr: GitHubPullRequest; path: string; line: number; side?: "LEFT" | "RIGHT" }): Promise<GitHubReviewComment>;
  /** Reply in a review thread. Sends `pull_request_review_comment`. */
  reply(body: RichText, where: { comment: GitHubReviewComment }): Promise<GitHubReviewComment>;
  resolve(target: { comment: GitHubReviewComment }): Promise<GitHubDelivery>;
  unresolve(target: { comment: GitHubReviewComment }): Promise<GitHubDelivery>;
  /** Request a review from people or the app's bot. Sends `pull_request` (action `review_requested`). */
  requestReview(reviewers: GitHubAuthor | GitHubAuthor[], where: { pr: GitHubPullRequest }): Promise<GitHubDelivery>;
  markReady(target: { pr: GitHubPullRequest }): Promise<GitHubDelivery>;
  merge(target: { pr: GitHubPullRequest; method?: "merge" | "squash" | "rebase" }): Promise<GitHubDelivery>;

  // ------------------------------------------------------------ checks
  /** Click "Re-run" on a check run. Sends `check_run` (action `rerequested`). */
  rerun(target: { checkRun: GitHubCheckRun }): Promise<GitHubDelivery>;
  /** Click one of the check run's requested actions. Sends `check_run` (action `requested_action`). */
  requestAction(identifier: string, where: { checkRun: GitHubCheckRun }): Promise<GitHubDelivery>;
}

export interface GitHubApp extends App {
  readonly channel: "github";
  readonly slug: string;
  /** The bot login, `<slug>[bot]`. */
  readonly botLogin: string;
  readonly appId: number;
  /** PEM private key the agent signs app JWTs with. Also printed by `channelstack env`. */
  readonly privateKey: string;
  readonly webhookSecret: string;
  /** Installation id for a repo the app is installed on. */
  installationId(repo: GitHubRepo): Promise<number>;
}

export type GitHubAuthor = GitHubUser | GitHubApp;

// ---------------------------------------------------------------------------
// Repos, commits, issues, PRs: what you read and wait on
// ---------------------------------------------------------------------------

export interface GitHubRepo extends Resource {
  readonly channel: "github";
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch: string;

  /** Install the app on this repo later. Sends `installation_repositories`. */
  installApp(app: GitHubApp): Promise<GitHubDelivery>;
  uninstallApp(app: GitHubApp): Promise<GitHubDelivery>;

  issue(number: number): Promise<GitHubIssue>;
  pullRequest(number: number): Promise<GitHubPullRequest>;
  /** Read a file as the agent last left it on a branch. */
  readFile(path: string, options?: { ref?: string }): Promise<string | undefined>;
  commits(options?: { branch?: string }): Promise<GitHubCommit[]>;
}

export interface GitHubCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: GitHubAuthor;
  readonly branch: string;
  readonly committedAt: Timestamp;
  checkRuns(): Promise<GitHubCheckRun[]>;
  statuses(): Promise<Array<{ context: string; state: "pending" | "success" | "failure" | "error"; author: GitHubAuthor }>>;
}

export interface GitHubIssue extends HasTranscript {
  readonly repo: GitHubRepo;
  readonly number: number;
  readonly url: string;
  readonly author: GitHubAuthor;

  refresh(): Promise<this>;
  title(): Promise<string>;
  state(): Promise<"open" | "closed">;
  labels(): Promise<string[]>;
  assignees(): Promise<GitHubAuthor[]>;
  comments(): Promise<GitHubComment[]>;
  /** Wait for the next new comment matching `from` (any author if omitted), after the last one seen. */
  waitForComment(options?: { from?: GitHubAuthor | string } & WaitOptions): Promise<GitHubComment>;
  /** The latest comment matching `from`, once the agent is quiet. Waits for at least one. */
  latestComment(options?: { from?: GitHubAuthor | string } & QuietOptions): Promise<GitHubComment>;
}

export interface GitHubPullRequest extends GitHubIssue {
  readonly head: string;
  readonly base: string;
  headCommit(): Promise<GitHubCommit>;
  reviews(): Promise<GitHubReview[]>;
  reviewComments(): Promise<GitHubReviewComment[]>;
  checkRuns(): Promise<GitHubCheckRun[]>;
  merged(): Promise<boolean>;
}

export interface GitHubComment {
  readonly id: number;
  readonly url: string;
  readonly issue: GitHubIssue;
  readonly author: GitHubAuthor;
  readonly body: string;
  readonly createdAt: Timestamp;
  /** The `issue_comment` delivery this comment caused, if the app is installed. */
  readonly delivery?: GitHubDelivery;
  refresh(): Promise<GitHubComment>;
  reactions(): Promise<Array<{ content: GitHubReaction; by: GitHubAuthor[] }>>;
}

export interface GitHubReview {
  readonly id: number;
  readonly author: GitHubAuthor;
  readonly state: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING";
  readonly body: string;
  readonly comments: readonly GitHubReviewComment[];
  readonly delivery?: GitHubDelivery;
}

export interface GitHubReviewComment extends HasTranscript {
  readonly id: number;
  readonly pr: GitHubPullRequest;
  readonly author: GitHubAuthor;
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
  readonly delivery?: GitHubDelivery;
  replies(): Promise<GitHubReviewComment[]>;
  resolved(): Promise<boolean>;
}

export interface GitHubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly app: GitHubApp | { slug: string };
  readonly headSha: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
  readonly title?: string;
  readonly summary?: string;
  readonly annotations: ReadonlyArray<{ path: string; startLine: number; endLine: number; level: "notice" | "warning" | "failure"; message: string }>;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface GitHubDelivery extends Delivery {
  readonly channel: "github";
  /** `X-GitHub-Event`, e.g. `issue_comment`, `pull_request`, `check_run`. */
  readonly type: string;
  /** Payload `action`, e.g. `created`, `opened`, `synchronize`. */
  readonly action?: string;
  /** `X-GitHub-Delivery` GUID. */
  readonly guid: string;

  /** Redeliver from the App's delivery log, as the GitHub UI and API do: same GUID, new attempt. */
  redeliver(): Promise<DeliveryAttempt>;
}
