import type {
  App, Delivery, DeliveryAttempt, HasTranscript, Inspectable, QuietOptions,
  Resource, RichText, Timestamp, User, WaitOptions,
} from "./common";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The `linear` test fixture: one in-memory workspace. The agent's app is installed
 * workspace-wide from `channelstack.config.ts`, as on real Linear, so nothing per resource.
 */
export interface LinearFixture extends Inspectable<LinearDelivery> {
  readonly app: LinearApp;
  /** GraphQL endpoint to give the agent (`@linear/sdk` `apiUrl`), e.g. `https://linear.localhost/graphql`. */
  readonly apiUrl: string;

  createUser(options: LinearUserOptions): Promise<LinearUser>;
  createTeam(options?: LinearTeamOptions): Promise<LinearTeam>;
}

export interface LinearUserOptions {
  name: string;
  /** Fixed id (UUID), for agents that allowlist by id. */
  id?: string;
  displayName?: string;
  email?: string;
  admin?: boolean;
  guest?: boolean;
  /** A real person (personal API key) in a live workspace. Also read from `CHANNELSTACK_LINEAR_USER_<NAME>_TOKEN`. */
  token?: string;
}

export interface LinearTeamOptions {
  /** Issue prefix, e.g. `ENG`. Generated if omitted, so parallel tests never collide. */
  key?: string;
  name?: string;
  members?: LinearUser[];
  /** Workflow states. Default: Backlog, Todo, In Progress, In Review, Done, Canceled. */
  states?: Array<{ name: string; type: LinearStateType }>;
  labels?: string[];
}

export type LinearStateType = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage";
export type LinearPriority = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// People: every action a person takes lives here
// ---------------------------------------------------------------------------

/**
 * A person in the workspace. Content first, where it happens as an option:
 * `ana.comment("@my-agent take a look", { issue })`, `ana.delegate(linear.app, { issue })`.
 */
export interface LinearUser extends User {
  readonly channel: "linear";
  readonly displayName: string;

  // ------------------------------------------------------------ issues
  createIssue(issue: {
    title: string;
    description?: RichText;
    priority?: LinearPriority;
    state?: string;
    labels?: string[];
    assignee?: LinearUser;
    /** Delegate to the app right away (opens an agent session). */
    delegate?: LinearApp;
    parent?: LinearIssue;
  }, where: { team: LinearTeam }): Promise<LinearIssue>;
  editIssue(changes: { title?: string; description?: RichText; priority?: LinearPriority }, target: { issue: LinearIssue }): Promise<LinearDelivery | undefined>;
  /** Delegate an issue to the app. Opens an agent session and sends `AgentSessionEvent` (action `created`). */
  delegate(app: LinearApp, where: { issue: LinearIssue }): Promise<LinearAgentSession>;
  /** Take an issue back from the app. */
  undelegate(target: { issue: LinearIssue }): Promise<LinearDelivery | undefined>;
  assign(assignee: LinearUser | undefined, target: { issue: LinearIssue }): Promise<LinearDelivery | undefined>;
  setState(state: string, target: { issue: LinearIssue }): Promise<LinearDelivery | undefined>;
  label(labels: string | string[], target: { issue: LinearIssue }): Promise<LinearDelivery | undefined>;

  // ------------------------------------------------------------ comments
  /**
   * Comment on an issue. Mentioning the app (`@my-agent`) opens an agent session
   * and sends `AgentSessionEvent` (action `created`).
   */
  comment(body: RichText, where: { issue: LinearIssue }): Promise<LinearComment>;
  reply(body: RichText, where: { comment: LinearComment }): Promise<LinearComment>;
  edit(body: RichText, target: { comment: LinearComment }): Promise<LinearDelivery | undefined>;
  delete(target: { comment: LinearComment }): Promise<LinearDelivery | undefined>;
  react(emoji: string, target: { comment: LinearComment }): Promise<void>;

  // ------------------------------------------------------------ agent sessions
  /** Send a follow-up in a session. Sends `AgentSessionEvent` (action `prompted`). */
  prompt(body: RichText, where: { session: LinearAgentSession }): Promise<LinearDelivery>;
  /** Answer a question the agent asked (an `elicitation` activity). */
  answer(body: RichText, where: { elicitation: LinearAgentActivity }): Promise<LinearDelivery>;
  /** Press Stop in Linear. Sends the stop signal to the agent. */
  stop(target: { session: LinearAgentSession }): Promise<LinearDelivery>;
}

export interface LinearApp extends App {
  readonly channel: "linear";
  /** OAuth access token the agent uses (`actor=app`). Also printed by `channelstack env`. */
  readonly accessToken: string;
  readonly webhookSecret: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type LinearAuthor = LinearUser | LinearApp;

// ---------------------------------------------------------------------------
// Teams, issues, comments, sessions: what you read and wait on
// ---------------------------------------------------------------------------

export interface LinearTeam extends Resource {
  readonly channel: "linear";
  readonly key: string;
  readonly name: string;
  issue(identifier: string): Promise<LinearIssue>;
}

export interface LinearIssue extends HasTranscript {
  readonly team: LinearTeam;
  readonly id: string;
  /** e.g. `ENG-12`. */
  readonly identifier: string;
  readonly url: string;
  readonly creator: LinearUser;

  refresh(): Promise<LinearIssue>;
  title(): Promise<string>;
  state(): Promise<{ name: string; type: LinearStateType }>;
  assignee(): Promise<LinearUser | undefined>;
  delegatedTo(): Promise<LinearApp | undefined>;
  labels(): Promise<string[]>;
  comments(): Promise<LinearComment[]>;
  /** Wait for the next new comment matching `from` (any author if omitted), after the last one seen. */
  waitForComment(options?: { from?: LinearAuthor | string } & WaitOptions): Promise<LinearComment>;
  /** The latest comment matching `from`, once the agent is quiet. Waits for at least one. */
  latestComment(options?: { from?: LinearAuthor | string } & QuietOptions): Promise<LinearComment>;
  /** Agent sessions on this issue, oldest first. */
  sessions(): Promise<LinearAgentSession[]>;
  /** The latest agent session, waiting for one to exist. */
  session(options?: WaitOptions): Promise<LinearAgentSession>;
}

export interface LinearComment extends HasTranscript {
  readonly id: string;
  readonly issue: LinearIssue;
  readonly author: LinearAuthor;
  readonly body: string;
  readonly createdAt: Timestamp;
  readonly url: string;
  /** The agent session this comment opened or belongs to, if any. */
  readonly session?: LinearAgentSession;
  readonly delivery?: LinearDelivery;
  replies(): Promise<LinearComment[]>;
}

export type LinearSessionState = "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale";

export interface LinearAgentSession extends HasTranscript {
  readonly id: string;
  readonly issue: LinearIssue;
  readonly app: LinearApp;
  readonly startedBy: LinearUser;
  /** The `AgentSessionEvent` (action `created`) delivery that opened the session. */
  readonly delivery: LinearDelivery;

  state(): Promise<LinearSessionState>;
  /** Wait until the session reaches one of these states. */
  waitForState(state: LinearSessionState | LinearSessionState[], options?: WaitOptions): Promise<LinearSessionState>;
  activities(): Promise<LinearAgentActivity[]>;
  /** Wait for the next new activity matching `type` (any type if omitted). */
  waitForActivity(options?: { type?: LinearActivityType } & WaitOptions): Promise<LinearAgentActivity>;
  /** External links the agent attached (`agentSessionUpdate` `addedExternalUrls`). */
  externalUrls(): Promise<Array<{ label: string; url: string }>>;
  plan(): Promise<Array<{ content: string; status: "pending" | "inProgress" | "completed" | "canceled" }>>;
}

export type LinearActivityType = "thought" | "action" | "elicitation" | "response" | "error" | "prompt";

export interface LinearAgentActivity {
  readonly id: string;
  readonly session: LinearAgentSession;
  readonly type: LinearActivityType;
  readonly author: LinearAuthor;
  readonly body?: string;
  /** For `action` activities. */
  readonly action?: { action: string; parameter?: string; result?: string };
  /** Shown only in the session's activity log, not as a comment. */
  readonly ephemeral: boolean;
  readonly createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface LinearDelivery extends Delivery {
  readonly channel: "linear";
  /** Webhook resource type, e.g. `AgentSessionEvent`, `Issue`, `Comment`. */
  readonly type: string;
  /** e.g. `created`, `prompted`, `update`, `remove`. */
  readonly action: string;
  readonly webhookId: string;

  /** Redeliver the same webhook (same `webhookId`), as Linear does on failure. */
  redeliver(): Promise<DeliveryAttempt>;
}
