import type {
  App, ApiCall, Delivery, DeliveryAttempt, Duration, FileInput, HasTranscript, Inspectable,
  QuietOptions, Resource, RichText, Timestamp, User, WaitOptions,
} from "./common";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The `slack` test fixture: one in-memory workspace. */
export interface SlackFixture extends Inspectable<SlackDelivery> {
  /** The agent's app from `channelstack.config.ts`. Add it to channels explicitly. */
  readonly app: SlackApp;
  /** Base URL to give the agent, e.g. `https://slack.localhost/api/`. */
  readonly apiUrl: string;

  createUser(options: SlackUserOptions): Promise<SlackUser>;

  /**
   * Create a channel. Only the listed participants are members; include `slack.app`
   * for the agent to receive events from it and post in it (Slack's real rule).
   */
  createChannel(options?: SlackChannelOptions): Promise<SlackChannel>;

  /** Simulate the workspace uninstalling the app (`app_uninstalled`, `tokens_revoked`). */
  uninstallApp(): Promise<SlackDelivery[]>;

  /**
   * Inject a transport fault for the agent's API calls. It applies to the whole workspace until it
   * is undone, or until the test's session closes. `await using` undoes it at the end of the scope.
   */
  fault(fault: SlackFault): Promise<SlackInjectedFault>;
}

export interface SlackUserOptions {
  name: string;
  /** Fixed user id, for agents that allowlist people by id. Generated (`U…`) otherwise. */
  id?: string;
  displayName?: string;
  realName?: string;
  email?: string;
  timezone?: string;
  admin?: boolean;
  owner?: boolean;
  /** A guest restricted to the channels it's added to. */
  guest?: boolean;
  /** Another (non-agent) bot, e.g. to test that the agent ignores other bots. */
  bot?: boolean;
  /**
   * A real person in a live workspace (see the implementation plan, section 5). Without it
   * the user is fake. Also read from `CHANNELSTACK_SLACK_USER_<NAME>_TOKEN`.
   */
  token?: string;
  /** Browser session for live-only UI actions (click, Stop, modal submit). */
  browser?: { storageState: string };
}

export interface SlackChannelOptions {
  /** Without `#`. Generated (`test-<id>`) if omitted, so parallel tests never collide. */
  name?: string;
  private?: boolean;
  participants?: SlackParticipant[];
  topic?: string;
  purpose?: string;
  /** Shared with another organization (Slack Connect). */
  shared?: boolean;
}

/** A fault that is in effect. */
export interface SlackInjectedFault extends AsyncDisposable {
  readonly id: string;
  undo(): Promise<void>;
}

export type SlackFault =
  | { type: "rate_limit"; operation?: string; retryAfter?: Duration; times?: number }
  | { type: "latency"; operation?: string; delay: Duration }
  | { type: "error"; operation: string; error: string; times?: number }
  | { type: "drop_socket"; after?: Duration };

// ---------------------------------------------------------------------------
// People: every action a person takes lives here
// ---------------------------------------------------------------------------

export type SlackMessageInput =
  | RichText
  | { text?: RichText; blocks?: unknown[]; files?: FileInput[]; metadata?: { event_type: string; event_payload: Record<string, unknown> } };

/**
 * A person in the workspace. Actions read as sentences, with the content first and
 * where it happens as an option: `ana.say("hi", { channel })`, `ben.click("Approve", { message })`.
 */
export interface SlackUser extends User {
  readonly channel: "slack";
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly isBot: boolean;

  // ------------------------------------------------------------ posting
  /**
   * Post a top-level message. `@name` mentions resolve to `<@U…>`.
   * `{ to }` opens (or reuses) a DM with the app or another person and posts there.
   */
  say(message: SlackMessageInput, where: { channel: SlackConversation } | { to: SlackParticipant | SlackParticipant[] }): Promise<SlackMessage>;
  /** Reply in a thread. Pass the thread or the message that starts it. */
  reply(message: SlackMessageInput, where: { thread: SlackThread | SlackMessage; alsoSendToChannel?: boolean }): Promise<SlackMessage>;
  edit(message: SlackMessageInput, target: { message: SlackMessage }): Promise<SlackMessage>;
  delete(target: { message: SlackMessage }): Promise<void>;
  react(emoji: string, target: { message: SlackMessage }): Promise<SlackDelivery | undefined>;
  unreact(emoji: string, target: { message: SlackMessage }): Promise<SlackDelivery | undefined>;

  // ------------------------------------------------------------ interacting
  /**
   * Click a button, found by its visible label or `action_id`. Without `message`,
   * the latest agent message in `thread` (or in `channel`) that has the button.
   * Sends `block_actions`.
   */
  click(button: string | { actionId: string; value?: string }, where: { message: SlackMessage } | { thread: SlackThread } | { channel: SlackConversation }): Promise<SlackDelivery>;
  /** Choose an option in a select menu, found by placeholder or `action_id`. */
  select(option: string | string[], where: { menu: string | { actionId: string }; message: SlackMessage }): Promise<SlackDelivery>;
  /** Run a message shortcut on a message. */
  shortcut(callbackId: string, target: { message: SlackMessage }): Promise<SlackDelivery>;
  /** Run a slash command, e.g. `ana.runCommand("/deploy web", { channel })`. */
  runCommand(command: `/${string}`, where: { channel: SlackConversation }): Promise<SlackDelivery>;
  /** Press Stop on the agent's work in a thread. */
  stop(target: { thread: SlackThread | SlackMessage }): Promise<SlackDelivery>;
  /** Wait for the agent to open a modal for this person (via `views.open`). */
  waitForModal(options?: WaitOptions & { title?: string | RegExp }): Promise<SlackModal>;

  // ------------------------------------------------------------ conversations
  /** Open (or reuse) a DM with the app, another person, or several (a group DM). */
  openDM(with_: SlackParticipant | SlackParticipant[]): Promise<SlackDM>;
  /**
   * Open the app's agent / assistant split view. Sends `assistant_thread_started`.
   * Requires `agentView` in the app config or manifest.
   */
  openAgentThread(options?: { from?: SlackChannel }): Promise<SlackAgentThread>;
  /** Click one of the suggested prompts in the agent split view. */
  pickPrompt(title: string, where: { thread: SlackAgentThread }): Promise<SlackMessage>;
  /** Move to another channel while the split view stays open (`assistant_thread_context_changed`). */
  switchContext(channel: SlackChannel, where: { thread: SlackAgentThread }): Promise<SlackDelivery>;
  /** Invite people or the app. Sends `member_joined_channel`. */
  invite(participants: SlackParticipant | SlackParticipant[], where: { channel: SlackChannel }): Promise<void>;
  /** Remove someone. Sends `member_left_channel` (or `channel_left` for the app). */
  kick(participant: SlackParticipant, where: { channel: SlackChannel }): Promise<void>;
  renameChannel(name: string, target: { channel: SlackChannel }): Promise<void>;
  archiveChannel(target: { channel: SlackChannel }): Promise<void>;

  // ------------------------------------------------------------ reading
  /** Messages only this person can see (ephemeral). */
  ephemeral(): Promise<SlackMessage[]>;
}

export interface SlackApp extends App {
  readonly channel: "slack";
  /** `xoxb-…` token the agent should use. Also printed by `channelstack env`. */
  readonly botToken: string;
  /** `xapp-…` token for Socket Mode. */
  readonly appToken?: string;
  readonly signingSecret: string;
  readonly scopes: readonly string[];
}

export type SlackParticipant = SlackUser | SlackApp;

// ---------------------------------------------------------------------------
// Conversations, messages, threads: what you read and wait on
// ---------------------------------------------------------------------------

/** What channels, DMs and agent threads have in common. */
export interface SlackConversation extends Resource, HasTranscript {
  readonly channel: "slack";
  readonly kind: "channel" | "private_channel" | "im" | "mpim";
  /** Slack conversation id (`C…`, `G…`, `D…`). */
  readonly id: string;

  /** Top-level messages, oldest first. */
  messages(): Promise<SlackMessage[]>;
  /** Wait for the next new top-level message matching `from` (any author if omitted). */
  waitForMessage(options?: { from?: SlackParticipant | string } & WaitOptions): Promise<SlackMessage>;
  members(): Promise<SlackParticipant[]>;
}

export interface SlackChannel extends SlackConversation {
  readonly kind: "channel" | "private_channel";
  readonly name: string;
}

export interface SlackDM extends SlackConversation {
  readonly kind: "im" | "mpim";
}

export interface SlackMessage extends HasTranscript {
  readonly ts: string;
  readonly conversation: SlackConversation;
  readonly author: SlackParticipant;
  readonly text: string;
  readonly blocks: readonly unknown[];
  readonly postedAt: Timestamp;
  /** Set when the agent posted it with `chat.postEphemeral`. */
  readonly visibleTo?: SlackUser;
  /** For streamed messages (`chat.startStream`). */
  readonly stream?: SlackStream;

  /** The thread rooted at this message (empty until someone replies). */
  readonly thread: SlackThread;
  /**
   * The event delivery this message caused to the agent, if any. When it caused
   * several (e.g. `app_mention` and `message.channels`), the `app_mention` one.
   */
  readonly delivery?: SlackDelivery;
  /** Every delivery this message caused. */
  deliveries(): Promise<SlackDelivery[]>;

  /** Re-read the latest state (edits, reactions, stream state). */
  refresh(): Promise<SlackMessage>;
  reactions(): Promise<Array<{ emoji: string; by: SlackParticipant[] }>>;
}

export interface SlackThread extends HasTranscript {
  readonly root: SlackMessage;
  readonly conversation: SlackConversation;

  replies(): Promise<SlackMessage[]>;
  /** Wait for the next new reply matching `from` (any author if omitted), after the last one seen. */
  waitForReply(options?: { from?: SlackParticipant | string } & WaitOptions): Promise<SlackMessage>;
  /** The latest reply matching `from`, once the agent is quiet. Waits for at least one. */
  latestReply(options?: { from?: SlackParticipant | string } & QuietOptions): Promise<SlackMessage>;
  /** The agent's current status line (`assistant.threads.setStatus`), if any. */
  status(): Promise<string | undefined>;
}

/** A thread in the agent / assistant split view. */
export interface SlackAgentThread extends SlackThread {
  readonly user: SlackUser;
  /** Suggested prompts the agent set (`assistant.threads.setSuggestedPrompts`). */
  suggestedPrompts(): Promise<Array<{ title: string; message: string }>>;
}

export interface SlackStream {
  readonly state: "open" | "stopped" | "completed";
  readonly chunks: readonly string[];
  readonly startedAt: Timestamp;
  readonly endedAt?: Timestamp;
  /** Resolves when the stream leaves the `open` state. */
  ended(options?: WaitOptions): Promise<SlackStream>;
}

/** A modal the agent opened for one person. Acting on it is that person acting. */
export interface SlackModal {
  readonly viewId: string;
  readonly user: SlackUser;
  readonly title: string;
  readonly blocks: readonly unknown[];
  /** Input labels or `action_id`s, mapped to their current values. */
  values(): Promise<Record<string, string | string[] | undefined>>;
  /** Fill inputs by label or `block_id.action_id`, then submit. Sends `view_submission`. */
  submit(values?: Record<string, string | string[]>): Promise<SlackDelivery>;
  /** Close the modal. Sends `view_closed` if the agent asked for it. */
  close(): Promise<SlackDelivery | undefined>;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export type SlackDeliveryType =
  | "event_callback"
  | "url_verification"
  | "block_actions"
  | "view_submission"
  | "view_closed"
  | "shortcut"
  | "message_action"
  | "slash_command";

export interface SlackDelivery extends Delivery<SlackDeliveryType> {
  readonly channel: "slack";
  /** For `event_callback`: the inner event type, e.g. `app_mention`, `message`, `reaction_added`. */
  readonly eventType?: string;
  readonly eventId?: string;

  /**
   * Retry the way Slack does: same `event_id`, with `X-Slack-Retry-Num` and
   * `X-Slack-Retry-Reason` set. `after` defaults to 3s, Slack's first retry delay.
   */
  retry(options?: { after?: Duration; reason?: "http_timeout" | "http_error" | "too_many_redirects" }): Promise<DeliveryAttempt>;
}

export type { ApiCall };
