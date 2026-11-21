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
  /** When the message was last edited, as a `ts`. */
  edited: string | undefined;
  readonly reactions: SlackReaction[];
  /** For a message posted with `chat.postEphemeral`: the only person who sees it. */
  readonly ephemeralFor: string | undefined;
  /** The deliveries this message caused to the agent, in order. */
  readonly deliveries: string[];
  readonly metadata: unknown;
}

/** Where a person posts: a conversation, or people to open (or reuse) a DM with. */
type SlackDestination = { channel: string } | { to: string[] };

export interface SlackMessageInput {
  text?: string | undefined;
  blocks?: unknown[] | undefined;
  metadata?: unknown;
}

/**
 * Every control action, written once. The fake implements it over its store; a live backend
 * implements the same interface against real Slack (architecture.md 3.3).
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
    },
  ): SlackUserRecord;
  createChannel(
    session: string,
    options: {
      name?: string | undefined;
      private?: boolean | undefined;
      participants: readonly string[];
      topic?: string | undefined;
      purpose?: string | undefined;
    },
  ): SlackConversationRecord;
  openConversation(session: string, user: string, withParticipants: readonly string[]): SlackConversationRecord;

  postAsUser(session: string, user: string, message: SlackMessageInput, where: SlackDestination): SlackMessageRecord;
  replyAsUser(
    session: string,
    user: string,
    message: SlackMessageInput,
    thread: { channel: string; ts: string },
    alsoSendToChannel: boolean,
  ): SlackMessageRecord;
  editAsUser(
    session: string,
    user: string,
    message: SlackMessageInput,
    target: { channel: string; ts: string },
  ): SlackMessageRecord;
  deleteAsUser(session: string, user: string, target: { channel: string; ts: string }): void;
  /** Add or remove a reaction. Returns the delivery it caused, if the app heard about it. */
  reactAsUser(
    session: string,
    user: string,
    emoji: string,
    target: { channel: string; ts: string },
    action: "add" | "remove",
  ): string | undefined;
  invite(session: string, user: string, participants: readonly string[], channel: string): void;
  kick(session: string, user: string, participant: string, channel: string): void;

  conversation(session: string, id: string): SlackConversationRecord;
  message(session: string, channel: string, ts: string): SlackMessageRecord;
  /** Top-level messages of a conversation, oldest first. */
  messages(session: string, channel: string): SlackMessageRecord[];
  /** Replies in a thread, oldest first, without the root. */
  replies(session: string, channel: string, ts: string): SlackMessageRecord[];
  user(session: string, id: string): SlackUserRecord;
}
