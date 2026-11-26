import { LivePlatformRefusal } from "../../core/errors/index.ts";
import type { Awaitable } from "../../core/router/index.ts";

/** The Slack fake's nouns, as the control API and the transcript see them. */

export interface SlackTeam {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
}

export interface SlackUserRecord {
  readonly id: string;
  /** Slack's handle (`name`), also what `@name` in a test's text resolves against. */
  readonly name: string;
  readonly displayName: string;
  readonly realName: string;
  readonly email: string | undefined;
  readonly timezone: string;
  readonly isAdmin: boolean;
  readonly isOwner: boolean;
  readonly isGuest: boolean;
  readonly isBot: boolean;
  /** The bot id (`B…`) of a bot user. */
  readonly botId: string | undefined;
  /** True when the test fixed this id, so it is given back when the session closes. */
  readonly fixedId: boolean;
}

export interface SlackAppRecord {
  readonly id: string;
  readonly name: string;
  readonly botId: string;
  /** The bot user people mention and add to channels. */
  readonly botUserId: string;
  readonly scopes: readonly string[];
  /** Event subscriptions, e.g. `app_mention`, `message.im`. */
  readonly botEvents: readonly string[];
  /** False after `uninstallApp`, until the session that did it closes. */
  installed: boolean;
  /** When the app was last changed, in seconds: its messages' `bot_profile.updated`. */
  readonly updated?: number;
}

export type SlackConversationKind = "channel" | "private_channel" | "im" | "mpim";

export interface SlackConversationRecord {
  readonly id: string;
  readonly kind: SlackConversationKind;
  name: string | undefined;
  readonly members: Set<string>;
  topic: string;
  purpose: string;
  readonly creator: string;
  readonly created: number;
  isArchived: boolean;
}

interface SlackReaction {
  readonly name: string;
  readonly users: string[];
}

export interface SlackMessageRecord {
  readonly ts: string;
  readonly conversation: string;
  /** The author's user id (for the app: its bot user). */
  readonly user: string;
  text: string;
  blocks: unknown[];
  /** The root message's `ts`, for a reply in a thread. */
  readonly threadTs: string | undefined;
  /** For a reply: who wrote the message that starts its thread (Slack's `parent_user_id`). */
  readonly parentUser?: string | undefined;
  /** When the message was last edited, as a `ts`. */
  edited: string | undefined;
  readonly reactions: SlackReaction[];
  /** For a message posted with `chat.postEphemeral`: the only person who sees it. */
  readonly ephemeralFor: string | undefined;
  /** The deliveries this message caused to the agent, in order. */
  readonly deliveries: string[];
  metadata: unknown;
  /** For a message the app streams (`chat.startStream`). */
  stream: SlackStreamRecord | undefined;
  /** A reply that was also sent to the channel (`reply_broadcast`): it shows among the channel's messages too. */
  readonly broadcast: boolean;
  /** Files shared with the message. */
  readonly files: readonly SlackFileRecord[];
}

/** A file a person shared, or the app uploaded (files upload v2): it has no bytes until the upload arrived. */
export interface SlackFileRecord {
  readonly id: string;
  /** Where the fake serves its bytes to a bot token (`url_private`); live, nothing does. */
  readonly url?: string | undefined;
  readonly name: string;
  title: string;
  /** The size the app announced, then the size of what arrived. */
  size: number;
  readonly user: string;
  readonly created: number;
  bytes: Uint8Array | undefined;
  /** Where the file was shared, once it was. */
  conversation: string | undefined;
}

interface SlackStreamRecord {
  /** `open` while the app appends, `completed` after `chat.stopStream`, `stopped` when a person pressed Stop. */
  state: "open" | "stopped" | "completed";
  /** The text of each call, in order. The message's text is all of them joined. */
  readonly chunks: string[];
  readonly startedAt: number;
  endedAt: number | undefined;
}

/** What the app has said about its work in one thread. */
export interface SlackThreadState {
  /** The status line (`assistant.threads.setStatus`), shown as "<app> <status>". Empty when cleared. */
  statusText: string;
  /** The agent session's lifecycle status (`agents.sessions.setStatus`). */
  sessionStatus: "active" | "processing" | "suspended" | "closed" | undefined;
  /** The thread's name in the person's list of conversations with the app (`assistant.threads.setTitle`). */
  title?: string;
  /** The prompts the app offers at the start of the thread (`assistant.threads.setSuggestedPrompts`). */
  suggestedPrompts?: Array<{ title: string; message: string }>;
}

/**
 * "Visible to" for a message nobody sees: the anchor a split-view thread hangs on. Slack has such
 * a root too; it holds the thread together and is never shown.
 */
export const NOBODY = "U00000000";

/** A modal the app opened for one person, for as long as it is open. */
export interface SlackViewRecord {
  readonly id: string;
  readonly session: string;
  /** Who sees it. */
  readonly user: string;
  /** The view as the app defined it, with every `block_id` and `action_id` filled in. */
  definition: Record<string, unknown> & { blocks: unknown[] };
  /** What is filled in: `values[block_id][action_id]`. */
  values: Record<string, Record<string, Record<string, unknown> & { type: string }>>;
  /** Changes with every update; `views.update` with an older one is refused. */
  hash: string;
  readonly rootViewId: string;
  readonly previousViewId: string | null;
  /** What the app said is wrong after a submission, by `block_id`. */
  errors: Record<string, string>;
  /** Submitted or closed. The record stays, so a test can still ask which modals the app opened. */
  closed: boolean;
}

/** A control a person means: by the label they see, by its `action_id`, or both. */
interface SlackControlRef {
  label?: string | undefined;
  actionId?: string | undefined;
}

/** Where a person looks for a control: on one message, or on the app's latest message that has it in a thread or a conversation. */
export type SlackControlScope =
  { message: { channel: string; ts: string } } | { thread: { channel: string; ts: string } } | { channel: string };

/** Where a person posts: a conversation, or people to open (or reuse) a DM with. */
type SlackDestination = { channel: string } | { to: string[] };

export interface SlackMessageInput {
  text?: string | undefined;
  blocks?: unknown[] | undefined;
  metadata?: unknown;
  /** Files a person shares with the message, each by its name. */
  files?: ReadonlyArray<{ name: string; bytes: Uint8Array }> | undefined;
}

/** The same world answering everything at once: the fake, which never waits for a platform. */
export type Immediate<World> = {
  [K in keyof World]: World[K] extends (...args: infer A) => infer R ? (...args: A) => Awaited<R> : World[K];
};

/** A person's credential as a test hands it over: the token, and the saved browser session for UI-only actions. */
interface SlackPersonCredentials {
  token?: string | undefined;
  browser?: { storageState: string } | undefined;
}

/**
 * Every control action, written once. The fake implements it over its store; the live backend
 * implements the same interface against real Slack (architecture.md 3.3). Looking up what the
 * session made (people, conversations) answers at once in both; acting and reading may wait for
 * the platform.
 */
export interface SlackWorld {
  team(): SlackTeam;
  app(): SlackAppRecord;

  createUser(
    session: string,
    options: {
      name: string;
      id?: string | undefined;
      displayName?: string | undefined;
      realName?: string | undefined;
      email?: string | undefined;
      timezone?: string | undefined;
      admin?: boolean | undefined;
      owner?: boolean | undefined;
      guest?: boolean | undefined;
      bot?: boolean | undefined;
    } & SlackPersonCredentials,
  ): Awaitable<SlackUserRecord>;
  createChannel(
    session: string,
    options: {
      name?: string | undefined;
      private?: boolean | undefined;
      participants: readonly string[];
      topic?: string | undefined;
      purpose?: string | undefined;
    },
  ): Awaitable<SlackConversationRecord>;
  openConversation(
    session: string,
    user: string,
    withParticipants: readonly string[],
  ): Awaitable<SlackConversationRecord>;

  postAsUser(
    session: string,
    user: string,
    message: SlackMessageInput,
    where: SlackDestination,
  ): Awaitable<SlackMessageRecord>;
  replyAsUser(
    session: string,
    user: string,
    message: SlackMessageInput,
    thread: { channel: string; ts: string },
    alsoSendToChannel: boolean,
  ): Awaitable<SlackMessageRecord>;
  editAsUser(
    session: string,
    user: string,
    message: SlackMessageInput,
    target: { channel: string; ts: string },
  ): Awaitable<SlackMessageRecord>;
  deleteAsUser(session: string, user: string, target: { channel: string; ts: string }): Awaitable<void>;
  /** Add or remove a reaction. Returns the delivery it caused, if the app heard about it. */
  reactAsUser(
    session: string,
    user: string,
    emoji: string,
    target: { channel: string; ts: string },
    action: "add" | "remove",
  ): Awaitable<string | undefined>;
  /** Press a button: found by its label, its `action_id`, or both. Returns the `block_actions` delivery; none live. */
  clickAsUser(
    session: string,
    user: string,
    button: SlackControlRef & { value?: string | undefined },
    where: SlackControlScope,
  ): Awaitable<string | undefined>;
  /** Choose options in a select menu on a message, by their text or value. Returns the `block_actions` delivery. */
  selectAsUser(
    session: string,
    user: string,
    options: readonly string[],
    menu: SlackControlRef,
    message: { channel: string; ts: string },
  ): string;
  /** Run a message shortcut on a message. Returns the `message_action` delivery. */
  shortcutAsUser(session: string, user: string, callbackId: string, message: { channel: string; ts: string }): string;
  /** Run a slash command in a conversation: `/deploy web staging`. Returns the command's delivery. */
  commandAsUser(session: string, user: string, command: string, channel: string): string;

  /** Press Stop on the app's work in a thread: open streams end, and the app is told. Returns the delivery. */
  stopAsUser(session: string, user: string, thread: { channel: string; ts: string }): string;

  /**
   * Open the app's split view: a new thread in the person's DM with the app, started from the
   * channel they are looking at (if any). Returns the thread's anchor.
   */
  openAgentThread(session: string, user: string, from: string | undefined): SlackMessageRecord;
  /** Pick one of the prompts the app suggested in a thread: the person says its message there. */
  pickPrompt(session: string, user: string, title: string, thread: { channel: string; ts: string }): SlackMessageRecord;
  /** Look at another channel while the split view stays open. Returns the delivery that tells the app. */
  switchContext(session: string, user: string, channel: string, thread: { channel: string; ts: string }): string;
  /** The prompts the app suggested in a thread. */
  suggestedPrompts(session: string, channel: string, ts: string): Array<{ title: string; message: string }>;

  /** How many Socket Mode connections the app holds open. 0 for an app that receives over HTTP. */
  socketConnections(): number;

  /** The modals the app opened for a person, in the order it opened them, closed ones included. */
  modals(session: string, user: string): SlackViewRecord[];
  modal(session: string, view: string): SlackViewRecord;
  /** Fill in inputs (by label, `block_id.action_id`, `action_id` or `block_id`) and submit. Returns the `view_submission` delivery. */
  submitModal(session: string, view: string, values: Readonly<Record<string, string | readonly string[]>>): string;
  /** Close a modal. Returns the `view_closed` delivery when the app asked to be told. */
  closeModal(session: string, view: string): string | undefined;

  invite(session: string, user: string, participants: readonly string[], channel: string): Awaitable<void>;
  kick(session: string, user: string, participant: string, channel: string): Awaitable<void>;

  conversation(session: string, id: string): SlackConversationRecord;
  /** The session's conversations, the one with the newest message last. */
  conversations(session: string): Awaitable<SlackConversationRecord[]>;
  /** The people the session created, in creation order. */
  users(session: string): SlackUserRecord[];
  message(session: string, channel: string, ts: string): Awaitable<SlackMessageRecord>;
  /** Top-level messages of a conversation, oldest first. */
  messages(session: string, channel: string): Awaitable<SlackMessageRecord[]>;
  /** Replies in a thread, oldest first, without the root. */
  replies(session: string, channel: string, ts: string): Awaitable<SlackMessageRecord[]>;
  user(session: string, id: string): SlackUserRecord;
  /** Every message of a thread, root first, as stored (ephemeral ones included). */
  thread(session: string, channel: string, ts: string): Awaitable<SlackMessageRecord[]>;
  /** Every message of a conversation in posting order, replies included. */
  everything(session: string, channel: string): Awaitable<SlackMessageRecord[]>;
  /** What the app has said about its work in a thread. */
  threadState(session: string, channel: string, ts: string): SlackThreadState;
  /** The ephemeral messages only this person can see, across the session's conversations. */
  ephemeral(session: string, user: string): SlackMessageRecord[];
}

/** Slack refusing what a person or the app tried, with Slack's own error code (`not_in_channel`). The fake and live both throw it. */
export class SlackRefusal extends LivePlatformRefusal {}
