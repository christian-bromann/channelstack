import { LivePlatformRefusal } from "../../core/errors/index.ts";
import type { Awaitable } from "../../core/router/index.ts";

/** Discord answers an interaction's HTTP request, or expects its callback, within 3 seconds. */
export const INTERACTION_WINDOW_MS = 3000;
/** A message's text may be 2000 characters. */
export const MAX_CONTENT = 2000;

/** A person in the guild. */
export interface DiscordUserRecord {
  readonly id: string;
  /** The name a test gave them, and their global display name. */
  readonly name: string;
  /** Their username: lower case, as Discord's are. */
  readonly username: string;
  readonly admin: boolean;
  /** Another bot, not the agent's: what it writes carries `author.bot`. */
  readonly bot: boolean;
  /** The test chose the id, so the session gives it back when it closes. */
  readonly fixedId: boolean;
}

/** The agent's app: its application and its bot user, who have the same id. */
export interface DiscordAppRecord {
  readonly id: string;
  readonly name: string;
  readonly botUserId: string;
  /** The role Discord makes for a bot when it joins a guild. */
  readonly roleId: string;
  /** The privileged intents switched on in the developer portal: `GUILD_MEMBERS`, `MESSAGE_CONTENT`, … */
  readonly privilegedIntents: readonly string[];
}

export interface DiscordGuildRecord {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
}

/** A text channel, a DM, or a thread (a channel of its own in Discord). */
type DiscordChannelKind = "text" | "dm" | "public_thread";

export interface DiscordChannelRecord {
  readonly id: string;
  readonly kind: DiscordChannelKind;
  name: string | undefined;
  /** For a thread: the channel it is in. */
  readonly parentId?: string | undefined;
  /** For a thread started from a message: that message, in the parent channel. */
  readonly starterId?: string | undefined;
  /** Who created it (a thread's owner). */
  readonly ownerId?: string | undefined;
  /**
   * Who can see it: a text channel's participants (the permission overwrites a private channel
   * has), a DM's two ends. A thread is seen by whoever sees its parent.
   */
  readonly members: Set<string>;
  /** Only admins may write in it; everyone who sees it may read. */
  readonly readOnly: boolean;
  topic?: string | undefined;
  readonly createdAt: number;
}

interface DiscordReaction {
  readonly emoji: string;
  readonly users: string[];
}

/** An interaction the message answers, as Discord keeps it on the message (`interaction_metadata`). */
interface DiscordAnsweredInteraction {
  readonly id: string;
  /** 2 a slash command, 3 a component. */
  readonly type: number;
  readonly name: string | undefined;
  readonly userId: string;
  /** For a component: the message it was on. */
  readonly messageId?: string | undefined;
}

export interface DiscordMessageRecord {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  content: string;
  embeds: unknown[];
  components: unknown[];
  /** The message this one replies to (`message_reference`). */
  readonly replyTo?: string | undefined;
  /** Discord's message type: 0 a message, 19 a reply, 20 a slash command's response. */
  readonly type: number;
  /** Discord's flags: 64 ephemeral, 128 a deferred response still loading. */
  flags: number;
  /** For an ephemeral response: the only person who sees it. */
  readonly ephemeralFor?: string | undefined;
  readonly interaction?: DiscordAnsweredInteraction | undefined;
  /** The user ids it mentions. */
  mentions: string[];
  readonly createdAt: number;
  editedAt?: number | undefined;
  reactions: DiscordReaction[];
  /** The thread started from it. */
  threadId?: string | undefined;
  /** The deliveries it caused. */
  readonly deliveries: string[];
  /** Sent in the fake by channelstack, not by a person or the app: "This interaction failed". */
  readonly system?: boolean;
}

/** What a person writes: text with `@name` mentions, or a message with embeds. */
export interface DiscordMessageInput {
  readonly content?: string | undefined;
  readonly embeds?: readonly unknown[] | undefined;
}

export interface DiscordUserOptions {
  readonly name: string;
  readonly id?: string | undefined;
  readonly admin?: boolean | undefined;
  readonly bot?: boolean | undefined;
  /** Live: the token of the second bot that acts as this person (decision 0026). */
  readonly token?: string | undefined;
}

/**
 * Why a person's DM is fake-only: live, a person is a bot of their own (decision 0026), and Discord
 * lets no bot open a DM with another bot.
 */
export const NO_BOT_DMS = "live, a person is a bot of their own, and Discord lets no bot write to another bot in a DM";
/** Why a person's command or button press is fake-only: Discord makes interactions of people only. */
export const NO_INTERACTIONS =
  "live, a person is a bot of their own, and Discord lets no bot run another app's command or press its button";

export interface DiscordChannelOptions {
  readonly name?: string | undefined;
  readonly participants: readonly string[];
  readonly readOnly?: boolean | undefined;
  readonly topic?: string | undefined;
}

/** Where a person writes: a channel or a thread, or a DM with someone. */
export type DiscordWhere = { readonly channel: string } | { readonly to: readonly string[] };

/** A button a person presses: by its label or its `custom_id`. */
export interface DiscordButtonRef {
  readonly label?: string | undefined;
  readonly customId?: string | undefined;
}

/** Where a button is: on a message, or on the app's latest message that has it in a channel or thread. */
export type DiscordControlWhere = { readonly message: DiscordMessageRef } | { readonly channel: string };

export interface DiscordMessageRef {
  readonly channel: string;
  readonly id: string;
}

/**
 * The Discord world: every action a test's people take, and what a test reads, written once.
 * The fake does it in memory; live, the agent's bot reads and arranges, and a second bot acts as
 * each person through Discord's API (decision 0026).
 */
export interface DiscordWorld {
  app(): DiscordAppRecord;
  guild(): DiscordGuildRecord;
  /** How many Gateway connections the bot holds open. Live there is no way to tell: 0. */
  gatewayConnections(): number;
  createUser(session: string, options: DiscordUserOptions): Awaitable<DiscordUserRecord>;
  user(session: string, id: string): DiscordUserRecord;
  users(session: string): DiscordUserRecord[];
  createChannel(session: string, options: DiscordChannelOptions): Awaitable<DiscordChannelRecord>;
  channel(session: string, id: string): DiscordChannelRecord;
  /** The session's channels, threads and DMs. */
  channels(session: string): Awaitable<DiscordChannelRecord[]>;
  say(session: string, user: string, input: DiscordMessageInput, where: DiscordWhere): Awaitable<DiscordMessageRecord>;
  reply(
    session: string,
    user: string,
    input: DiscordMessageInput,
    to: DiscordMessageRef,
  ): Awaitable<DiscordMessageRecord>;
  edit(
    session: string,
    user: string,
    input: DiscordMessageInput,
    message: DiscordMessageRef,
  ): Awaitable<DiscordMessageRecord>;
  delete(session: string, user: string, message: DiscordMessageRef): Awaitable<void>;
  /** Returns the delivery the reaction caused, if one went to the bot. */
  react(
    session: string,
    user: string,
    emoji: string,
    message: DiscordMessageRef,
    direction: "add" | "remove",
  ): Awaitable<string | undefined>;
  startThread(
    session: string,
    user: string,
    name: string,
    from: { readonly message: DiscordMessageRef } | { readonly channel: string },
  ): Awaitable<DiscordChannelRecord>;
  openDM(session: string, user: string, other: string): Awaitable<DiscordChannelRecord>;
  /** Let people or the app see a channel. */
  invite(session: string, user: string, participants: readonly string[], channel: string): Awaitable<void>;
  /** Run one of the app's slash commands. Returns the interaction's delivery; none live, where Discord tells the agent. */
  runCommand(session: string, user: string, command: string, channel: string): Awaitable<string | undefined>;
  click(
    session: string,
    user: string,
    button: DiscordButtonRef,
    where: DiscordControlWhere,
  ): Awaitable<string | undefined>;
  /** A channel's or thread's messages, oldest first: what a person scrolls through, ephemeral ones left out. */
  messages(session: string, channel: string): Awaitable<DiscordMessageRecord[]>;
  message(session: string, channel: string, id: string): Awaitable<DiscordMessageRecord>;
  /** What answers a message: replies to it in its channel, and the messages of the thread started from it. */
  replies(session: string, channel: string, id: string): Awaitable<DiscordMessageRecord[]>;
  /** The threads in a channel. */
  threads(session: string, channel: string): Awaitable<DiscordChannelRecord[]>;
  /** Ephemeral messages only this person sees. Live, the agent's own calls would show them: proxy mode. */
  ephemeral(session: string, user: string): Awaitable<DiscordMessageRecord[]>;
}

/**
 * Discord's JSON error codes the fake answers with: the name the control API surfaces, Discord's
 * own message, and its HTTP status.
 */
export const DISCORD_ERRORS = {
  10003: { name: "unknown_channel", message: "Unknown Channel", status: 404 },
  10008: { name: "unknown_message", message: "Unknown Message", status: 404 },
  10013: { name: "unknown_user", message: "Unknown User", status: 404 },
  10014: { name: "unknown_emoji", message: "Unknown Emoji", status: 400 },
  10015: { name: "unknown_webhook", message: "Unknown Webhook", status: 404 },
  10062: { name: "unknown_interaction", message: "Unknown interaction", status: 404 },
  10063: { name: "unknown_application_command", message: "Unknown application command", status: 404 },
  40060: {
    name: "interaction_already_acknowledged",
    message: "Interaction has already been acknowledged.",
    status: 400,
  },
  50001: { name: "missing_access", message: "Missing Access", status: 403 },
  50005: { name: "cannot_edit_others_message", message: "Cannot edit a message authored by another user", status: 403 },
  50006: { name: "empty_message", message: "Cannot send an empty message", status: 400 },
  50007: { name: "cannot_message_user", message: "Cannot send messages to this user", status: 403 },
  50013: { name: "missing_permissions", message: "Missing Permissions", status: 403 },
  50035: { name: "invalid_form_body", message: "Invalid Form Body", status: 400 },
  160004: {
    name: "thread_already_created",
    message: "A thread has already been created for this message",
    status: 400,
  },
} as const;

export type DiscordErrorCode = keyof typeof DISCORD_ERRORS;

/** Every name a refusal of Discord's has, for a route's `errors`. */
export const discordErrors = (...codes: DiscordErrorCode[]) => codes.map((code) => DISCORD_ERRORS[code].name);

/**
 * Discord refusing something, with its JSON error code: the fake's API answers it in Discord's
 * shape (`{ code, message, errors }`), and the control API surfaces it by name (`missing_access`).
 */
export class DiscordRefusal extends LivePlatformRefusal {
  readonly discordCode: number;
  /** The status Discord answers it with: always one, unlike a refusal from a page in front of the API. */
  declare readonly httpStatus: number;
  /** For 50035: which fields are wrong, as Discord nests them. */
  readonly errors: Record<string, unknown> | undefined;

  constructor(
    code: DiscordErrorCode,
    options: { message?: string; errors?: Record<string, unknown>; status?: number } = {},
  ) {
    const known = DISCORD_ERRORS[code];
    super(known.name, options.message ?? known.message, { code }, options.status ?? known.status);
    this.discordCode = code;
    this.errors = options.errors;
  }
}
