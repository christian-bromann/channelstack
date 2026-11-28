import { BUILT_IN_APP } from "../../../core/apps/index.ts";
import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import { deliveryKit } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { richTextPieces } from "../../../core/rich-text/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { DISCORD_IDS, discordSnowflake } from "../ids.ts";
import {
  type Author,
  CHANNEL_TYPE,
  channelObject,
  JOINED_AT,
  memberObject,
  messageDispatch,
  messageObject,
  numbered,
  roleObject,
  userObject,
  withoutContent,
} from "../payloads.ts";
import {
  ADMIN_PERMISSIONS,
  BOT_PERMISSIONS,
  EVERYONE_PERMISSIONS,
  has,
  overwritesOf,
  type Permission,
  permissionsIn,
} from "../permissions.ts";
import { botIdOf, DISCORD_SECRETS } from "../secrets.ts";
import { signInteraction } from "../signing.ts";
import {
  type DiscordAppRecord,
  type DiscordButtonRef,
  type DiscordChannelOptions,
  type DiscordChannelRecord,
  type DiscordControlWhere,
  type DiscordMessageInput,
  type DiscordMessageRecord,
  type DiscordMessageRef,
  DiscordRefusal,
  type DiscordUserOptions,
  type DiscordWhere,
  type DiscordWorld,
  INTERACTION_WINDOW_MS,
  MAX_CONTENT,
} from "../world.ts";
import { type Gateways, type Intent, INTENTS } from "./gateway.ts";
import { createInteractions, type Interactions } from "./interactions.ts";
import type { DiscordFault, DiscordStore } from "./store.ts";

/** A message may have 10 embeds. */
const MAX_EMBEDS = 10;

/** The guild's members, as a bot sees them: the bot is one too, with its own role. */
type Member = { id: string; roles: Array<{ id: string; permissions: bigint }> };

/** What the fake world adds for the provider API, where the bot acts, and for what only a fake can do. */
export interface FakeDiscordWorld extends DiscordWorld {
  readonly store: DiscordStore;
  readonly interactions: Interactions;
  /** Who wrote something: a person, or an app's bot. Undefined for an id nobody in the guild has. */
  authorOf(id: string): Author | undefined;
  /** What an app's bot (the built-in one unless named) may do in a channel, as Discord computes it. */
  botPermissions(channel: DiscordChannelRecord, app?: DiscordAppRecord): bigint;
  /** Refuse unless the app's bot sees the channel and may do this there, with Discord's codes (50001, 50013). */
  requireBot(app: DiscordAppRecord, channel: DiscordChannelRecord, ...needed: Permission[]): void;
  /** A message as REST answers it to an app's bot (the built-in one unless named). */
  messageWire(message: DiscordMessageRecord, reader?: DiscordAppRecord): Record<string, unknown>;
  /** A channel as REST answers it to an app's bot (the built-in one unless named). */
  channelWire(channel: DiscordChannelRecord, reader?: DiscordAppRecord): Record<string, unknown>;
  /**
   * The content checks every message goes through: empty, too long, too many embeds. `within`
   * nests the fields Discord names, as it does for an interaction's response (`data.content`).
   */
  checkContent(input: { content?: unknown; embeds?: unknown; components?: unknown }, within?: "data"): void;
  /** The guild's roles, as `GET /guilds/{id}/roles` and GUILD_CREATE list them. */
  guildRoles(): Array<Record<string, unknown>>;
  /** A member's role ids: a bot's own role, an admin's Admin. */
  rolesOf(id: string): string[];
  /** An app's bot posts (the built-in one unless named). The caller has checked it may. */
  postAsBot(
    channel: DiscordChannelRecord,
    input: { content: string; embeds: unknown[]; components: unknown[] },
    options?: {
      replyTo?: string | undefined;
      type?: number;
      flags?: number;
      ephemeralFor?: string | undefined;
      interaction?: DiscordMessageRecord["interaction"];
    },
    app?: DiscordAppRecord,
  ): DiscordMessageRecord;
  /** Change a message's content and tell the bots. The caller has checked who may. */
  update(
    message: DiscordMessageRecord,
    changes: { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number },
  ): DiscordMessageRecord;
  /** Remove a message and tell the bots. */
  remove(message: DiscordMessageRecord): void;
  /** Add or remove someone's reaction, and tell the bots. Returns the built-in app's delivery. */
  reactAs(message: DiscordMessageRecord, who: string, emoji: string, direction: "add" | "remove"): string | undefined;
  /** Start a thread, from a message or in a channel, and tell the bots. */
  threadAs(
    owner: string,
    parent: DiscordChannelRecord,
    name: string,
    starter: DiscordMessageRecord | undefined,
  ): DiscordChannelRecord;
  /** The DM between an app's bot (the built-in one unless named) and a person, opened if it isn't yet. */
  dmWith(userId: string, app?: DiscordAppRecord): DiscordChannelRecord;
  /**
   * The bot typed in a channel (`POST /channels/{id}/typing`). The fake takes it, as Discord does,
   * and shows nothing: a transcript is what was written.
   */
  typing(channel: DiscordChannelRecord): void;
  /** Send a Gateway event to one app's bot, if it hears it. Returns the delivery. */
  dispatchTo(
    app: DiscordAppRecord,
    session: string | undefined,
    type: string,
    payload: unknown,
    intent: Intent | undefined,
  ): string | undefined;
  /** The guild's apps, the built-in one first. */
  apps(): DiscordAppRecord[];
  /** The app whose application or bot user this is. */
  appOf(id: string): DiscordAppRecord | undefined;
  /** Make an app by name, or return the one made with the same settings (decision 0027). */
  createApp(
    session: string | undefined,
    options: { name: string; privilegedIntents?: readonly string[] | undefined },
  ): DiscordAppRecord;
  /** An app a test made writes, as its own `POST /channels/{id}/messages` would: in a channel, or in a DM with a person. */
  sayAsApp(session: string, app: string, input: DiscordMessageInput, where: DiscordWhere): DiscordMessageRecord;
  /** An app a test made replies to a message, as Discord's reply. */
  replyAsApp(session: string, app: string, input: DiscordMessageInput, to: DiscordMessageRef): DiscordMessageRecord;
  /** An app a test made reacts to a message, or takes its reaction back. Returns the built-in app's delivery. */
  reactAsApp(
    session: string,
    app: string,
    emoji: string,
    message: DiscordMessageRef,
    direction: "add" | "remove",
  ): string | undefined;
  deliveries(session: string): DeliveryRecord[];
  delivery(session: string, id: string): DeliveryRecord;
  resend(session: string, id: string, options: { badSignature: boolean }): Promise<DeliveryAttempt>;
  redeliver(session: string, id: string): Promise<DeliveryAttempt>;
  addFault(session: string, fault: Omit<DiscordFault, "id" | "session">): string;
  removeFault(session: string, id: string): void;
  /** What the bot left open in a session: a deferred response it never finished. */
  openWork(session: string): string[];
  /** The session a channel belongs to. */
  sessionOf(channelId: string): string | undefined;
  /** The text a person wrote, with `@name` as Discord's mentions. */
  mentionText(session: string, text: string): { content: string; mentions: string[] };
}

/** The mentions in a message's content: `<@id>` and `<@!id>`. */
const mentionsIn = (content: string): string[] => [
  ...new Set([...content.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1] as string)),
];

/** A delivery an event caused, and the app it went to. */
interface Sent {
  readonly app: string;
  readonly id: string;
}

/** The built-in app's delivery among those an event caused: what an action's delivery is. */
const builtInDelivery = (sent: readonly Sent[]): string | undefined => sent.find((one) => one.app === BUILT_IN_APP)?.id;

export function createFakeWorld(
  context: DriverContext,
  store: DiscordStore,
  gateways: Gateways,
  defaults: { privilegedIntents: readonly string[] },
): FakeDiscordWorld {
  const { ids, clock } = context;
  /** Discord's deliveries: interactions over HTTP, signed with Ed25519 with each app's own key, never retried; dispatches over the Gateway. */
  const kit = deliveryKit(context, {
    driver: "discord",
    timeoutMs: INTERACTION_WINDOW_MS,
    sign: (secret, body, atMs) => signInteraction(secret, body, atMs),
    secret: (app) => context.apps.secret(app, "interactionsKey"),
    forgedSecret: () => DISCORD_SECRETS.interactionsKey.generate(),
  });

  const app = () => store.app;
  const guild = () => store.guild;
  const authorOf = (id: string): Author | undefined => {
    const bot = store.appOf(id);
    if (bot) return { kind: "app", app: bot };
    const user = store.users.find(id);
    return user ? { kind: "user", user } : undefined;
  };

  const memberOf = (id: string): Member => {
    const bot = store.appOf(id);
    if (bot) return { id, roles: [{ id: bot.roleId, permissions: BOT_PERMISSIONS }] };
    const user = store.users.find(id);
    return { id, roles: user?.admin ? [{ id: store.adminRole, permissions: ADMIN_PERMISSIONS }] : [] };
  };

  const rolesOf = (id: string) => memberOf(id).roles.map((role) => role.id);

  /** A thread's permissions are its parent's. */
  const governing = (channel: DiscordChannelRecord): DiscordChannelRecord =>
    channel.kind === "public_thread" && channel.parentId ? (store.channels.find(channel.parentId) ?? channel) : channel;

  const permissionsOf = (id: string, channel: DiscordChannelRecord): bigint => {
    if (channel.kind === "dm") return channel.members.has(id) ? EVERYONE_PERMISSIONS : 0n;
    const parent = governing(channel);
    return permissionsIn(
      memberOf(id),
      { id: store.everyoneRole, permissions: EVERYONE_PERMISSIONS },
      overwritesOf(parent, store.everyoneRole),
    );
  };

  const botPermissions = (channel: DiscordChannelRecord, of: DiscordAppRecord = app()) =>
    permissionsOf(of.botUserId, channel);
  const botSees = (channel: DiscordChannelRecord, of: DiscordAppRecord = app()) =>
    has(botPermissions(channel, of), "VIEW_CHANNEL");

  const requireBot = (of: DiscordAppRecord, channel: DiscordChannelRecord, ...needed: Permission[]) => {
    const permissions = botPermissions(channel, of);
    if (!has(permissions, "VIEW_CHANNEL")) throw new DiscordRefusal(50001);
    for (const permission of needed) if (!has(permissions, permission)) throw new DiscordRefusal(50013);
  };

  const sessionOf = (channelId: string) => store.channels.owner(channelId);

  const userWire = (id: string) => {
    const author = authorOf(id);
    return author ? userObject(author) : { id };
  };

  const lastMessageId = (channel: string) => store.messagesIn(channel).at(-1)?.id ?? null;

  const channelWire = (channel: DiscordChannelRecord, reader: DiscordAppRecord = app()): Record<string, unknown> =>
    channelObject(channel, {
      guild: guild(),
      overwrites: overwritesOf(channel, store.everyoneRole),
      recipients: [...channel.members].filter((id) => id !== reader.botUserId).map(userWire),
      lastMessageId: lastMessageId(channel.id),
      messageCount: store.messagesIn(channel.id).length,
    });

  const messageWire = (
    message: DiscordMessageRecord,
    reader: DiscordAppRecord = app(),
    depth = 0,
  ): Record<string, unknown> => {
    const channel = store.channels.find(message.channelId);
    const referenced =
      message.replyTo === undefined || depth > 0 ? undefined : store.findMessage(message.channelId, message.replyTo);
    const thread = message.threadId === undefined ? undefined : store.channels.find(message.threadId);
    return messageObject(message, {
      author: authorOf(message.authorId) ?? { kind: "app", app: app() },
      mentions: message.mentions.map(userWire),
      referenced: referenced
        ? messageWire(referenced, reader, depth + 1)
        : message.replyTo === undefined
          ? undefined
          : null,
      ...(thread ? { thread: channelWire(thread, reader) } : {}),
      guildId: channel?.kind === "dm" ? undefined : guild().id,
      reader: reader.botUserId,
      // An interaction's response is its app's: the one whose bot wrote it.
      applicationId: (store.appOf(message.authorId) ?? app()).id,
      interactionUser: message.interaction ? userWire(message.interaction.userId) : undefined,
    });
  };

  /**
   * Whether an app's bot can be sent anything: the built-in one always (a dispatch waits for it to
   * connect), another once its bot has identified, since an app nobody drives has no connection.
   */
  const reachable = (of: DiscordAppRecord) => of === app() || gateways.of(of.name).intents() !== undefined;

  /** The delivery queue's record for one Gateway event to one app's bot, if it hears it: its session, its intent. */
  const dispatchTo = (
    of: DiscordAppRecord,
    session: string | undefined,
    type: string,
    payload: unknown,
    intent: Intent | undefined,
  ) => {
    if (session === undefined || !reachable(of)) return undefined;
    const gateway = gateways.of(of.name);
    const intents = gateway.intents();
    if (intent !== undefined && intents !== undefined && (intents & INTENTS[intent]) === 0) return undefined;
    const id = discordSnowflake(ids);
    kit.send({
      id,
      session,
      app: of.name,
      type,
      url: gateways.url(),
      transport: gateway.transport,
      body: JSON.stringify(payload),
      retry: false,
      meta: { payload },
    });
    return id;
  };

  /**
   * Send a Gateway event about a channel to every app's bot that sees it, each with the payload as
   * that bot reads it (decision 0027): Discord sends one bot's messages to the others as a person's.
   */
  const broadcast = (
    channel: DiscordChannelRecord,
    type: string,
    payloadFor: (reader: DiscordAppRecord) => unknown,
    intent: Intent | undefined,
    sees: (reader: DiscordAppRecord) => boolean = (reader) => botSees(channel, reader),
  ): Sent[] =>
    store.apps.all().flatMap((reader) => {
      if (!sees(reader)) return [];
      const id = dispatchTo(reader, sessionOf(channel.id), type, payloadFor(reader), intent);
      return id === undefined ? [] : [{ app: reader.name, id }];
    });

  /**
   * A message as an app's Gateway gets it: the guild's member, and no content without the intent
   * unless the bot may have it anyway (its own, a DM, one that mentions it).
   */
  const messageEvent = (message: DiscordMessageRecord, channel: DiscordChannelRecord, reader: DiscordAppRecord) => {
    const guildId = channel.kind === "dm" ? undefined : guild().id;
    const wire = messageWire(message, reader);
    // In a guild, the Gateway's MESSAGE_CREATE gives each mentioned user their partial member too (REST doesn't).
    if (guildId)
      wire.mentions = (wire.mentions as Array<Record<string, unknown>>).map((user) => ({
        ...user,
        member: memberObject(rolesOf(String(user.id)), JOINED_AT),
      }));
    const object = messageDispatch(wire, {
      guildId,
      member: guildId ? memberObject(rolesOf(message.authorId), JOINED_AT) : undefined,
      channelType: CHANNEL_TYPE[channel.kind],
    });
    const intents = gateways.of(reader.name).intents();
    const mayRead =
      intents === undefined ||
      (intents & INTENTS.MESSAGE_CONTENT) !== 0 ||
      channel.kind === "dm" ||
      message.authorId === reader.botUserId ||
      message.mentions.includes(reader.botUserId);
    return mayRead ? object : withoutContent(object);
  };

  const messageIntent = (channel: DiscordChannelRecord): Intent =>
    channel.kind === "dm" ? "DIRECT_MESSAGES" : "GUILD_MESSAGES";

  /**
   * Tell every bot that sees the channel about a new message, unless it is for one person alone.
   * The one message path: the loop guard counts here what apps write (decision 0027).
   */
  const announce = (message: DiscordMessageRecord, channel: DiscordChannelRecord) => {
    if (message.ephemeralFor !== undefined) return;
    const session = sessionOf(channel.id);
    const writer = store.appOf(message.authorId);
    if (session !== undefined) {
      context.loops.wrote(session, channel.id, writer ? { kind: "app", name: writer.name } : { kind: "person" });
      if (writer && !context.loops.allows(session, channel.id)) return;
    }
    const sent = broadcast(
      channel,
      "MESSAGE_CREATE",
      (reader) => messageEvent(message, channel, reader),
      messageIntent(channel),
    );
    for (const one of sent) message.deliveries.push(one.id);
  };

  const checkContent: FakeDiscordWorld["checkContent"] = (input, within) => {
    const content = typeof input.content === "string" ? input.content : "";
    const embeds = Array.isArray(input.embeds) ? input.embeds : [];
    const components = Array.isArray(input.components) ? input.components : [];
    /** Discord's Invalid Form Body for one field, nested as the request has it. */
    const tooLong = (field: string, limit: number) => {
      const error = {
        [field]: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: `Must be ${limit} or fewer in length.` }] },
      };
      return new DiscordRefusal(50035, { errors: within ? { [within]: error } : error });
    };
    if (content.length > MAX_CONTENT) throw tooLong("content", MAX_CONTENT);
    if (embeds.length > MAX_EMBEDS) throw tooLong("embeds", MAX_EMBEDS);
    if (content.trim() === "" && embeds.length === 0 && components.length === 0) throw new DiscordRefusal(50006);
  };

  const newMessage = (
    channel: DiscordChannelRecord,
    authorId: string,
    input: { content: string; embeds: unknown[]; components: unknown[] },
    options: {
      replyTo?: string | undefined;
      type?: number;
      flags?: number;
      ephemeralFor?: string | undefined;
      interaction?: DiscordMessageRecord["interaction"];
      system?: boolean;
    } = {},
  ): DiscordMessageRecord =>
    store.addMessage({
      id: discordSnowflake(ids),
      channelId: channel.id,
      authorId,
      content: input.content,
      embeds: [...input.embeds],
      components: numbered(input.components),
      replyTo: options.replyTo,
      type: options.type ?? (options.replyTo === undefined ? 0 : 19),
      flags: options.flags ?? 0,
      ephemeralFor: options.ephemeralFor,
      interaction: options.interaction,
      mentions: mentionsIn(input.content),
      createdAt: clock(),
      reactions: [],
      deliveries: [],
      ...(options.system ? { system: true } : {}),
    });

  const postAsBot: FakeDiscordWorld["postAsBot"] = (channel, input, options = {}, by = app()) => {
    const message = newMessage(channel, by.botUserId, input, options);
    announce(message, channel);
    return message;
  };

  const update: FakeDiscordWorld["update"] = (message, changes) => {
    if (changes.content !== undefined) {
      message.content = changes.content;
      message.mentions = mentionsIn(changes.content);
    }
    if (changes.embeds !== undefined) message.embeds = [...changes.embeds];
    if (changes.components !== undefined) message.components = numbered(changes.components);
    if (changes.flags !== undefined) message.flags = changes.flags;
    message.editedAt = clock();
    const channel = store.channels.find(message.channelId);
    if (channel && message.ephemeralFor === undefined) {
      const sent = broadcast(
        channel,
        "MESSAGE_UPDATE",
        (reader) => messageEvent(message, channel, reader),
        messageIntent(channel),
      );
      for (const one of sent) message.deliveries.push(one.id);
    }
    return message;
  };

  const remove: FakeDiscordWorld["remove"] = (message) => {
    store.removeMessage(message.channelId, message.id);
    const channel = store.channels.find(message.channelId);
    if (channel && message.ephemeralFor === undefined) {
      broadcast(
        channel,
        "MESSAGE_DELETE",
        () => ({ id: message.id, channel_id: channel.id, ...(channel.kind === "dm" ? {} : { guild_id: guild().id }) }),
        messageIntent(channel),
      );
    }
  };

  const reactAs: FakeDiscordWorld["reactAs"] = (message, who, emoji, direction) => {
    const channel = store.channels.find(message.channelId);
    if (!channel) throw new DiscordRefusal(10003);
    let reaction = message.reactions.find((existing) => existing.emoji === emoji);
    if (direction === "add") {
      if (reaction?.users.includes(who)) return undefined;
      if (!reaction) {
        reaction = { emoji, users: [] };
        message.reactions.push(reaction);
      }
      reaction.users.push(who);
    } else {
      if (!reaction?.users.includes(who)) return undefined;
      reaction.users.splice(reaction.users.indexOf(who), 1);
      if (reaction.users.length === 0) message.reactions.splice(message.reactions.indexOf(reaction), 1);
    }
    const guildId = channel.kind === "dm" ? undefined : guild().id;
    const sent = broadcast(
      channel,
      direction === "add" ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
      () => ({
        user_id: who,
        channel_id: channel.id,
        message_id: message.id,
        emoji: { id: null, name: emoji },
        burst: false,
        type: 0,
        ...(guildId
          ? {
              guild_id: guildId,
              ...(direction === "add"
                ? {
                    member: { ...memberObject(rolesOf(who), JOINED_AT), user: userWire(who) },
                    message_author_id: message.authorId,
                  }
                : {}),
            }
          : {}),
        ...(direction === "add" ? { burst_colors: [] } : {}),
      }),
      channel.kind === "dm" ? "DIRECT_MESSAGE_REACTIONS" : "GUILD_MESSAGE_REACTIONS",
    );
    return builtInDelivery(sent);
  };

  const threadAs: FakeDiscordWorld["threadAs"] = (owner, parent, name, starter) => {
    if (starter?.threadId !== undefined) throw new DiscordRefusal(160004);
    const id = starter?.id ?? discordSnowflake(ids);
    const session = sessionOf(parent.id) ?? "";
    const thread = store.addChannel(
      {
        id,
        kind: "public_thread",
        name: name.slice(0, 100),
        parentId: parent.id,
        starterId: starter?.id,
        ownerId: owner,
        members: new Set([owner]),
        readOnly: false,
        createdAt: clock(),
      },
      session,
    );
    if (starter) starter.threadId = thread.id;
    broadcast(
      thread,
      "THREAD_CREATE",
      (reader) => ({ ...channelWire(thread, reader), newly_created: true, member: undefined }),
      "GUILDS",
    );
    return thread;
  };

  const dmWith: FakeDiscordWorld["dmWith"] = (userId, by = app()) => {
    const key = [by.botUserId, userId].sort().join(":");
    const existing = store.dms.get(key);
    const found = existing === undefined ? undefined : store.channels.find(existing);
    if (found) return found;
    const session = store.users.owner(userId) ?? "";
    const channel = store.addChannel(
      {
        id: discordSnowflake(ids),
        kind: "dm",
        name: undefined,
        members: new Set([by.botUserId, userId]),
        readOnly: false,
        createdAt: clock(),
      },
      session,
    );
    store.dms.set(key, channel.id);
    return channel;
  };

  const typing: FakeDiscordWorld["typing"] = () => {};

  const mentionText = (session: string, text: string) => {
    const lookup = (name: string) => {
      const named = store.apps.namedIn(session, name);
      if (named) return named.botUserId;
      const wanted = name.toLowerCase();
      return store.usersOf(session).find((user) => user.name.toLowerCase() === wanted || user.username === wanted)?.id;
    };
    const pieces = richTextPieces(text, lookup);
    const content = pieces.map((piece) => ("text" in piece ? piece.text : `<@${piece.mention}>`)).join("");
    return { content, mentions: mentionsIn(content) };
  };

  // --- People -------------------------------------------------------------------------------

  const personIn = (session: string, id: string) => store.users.get(session, id);

  /** A person may see this channel, or refuse as Discord's client would: they don't have it. */
  const visibleTo = (session: string, user: string, id: string): DiscordChannelRecord => {
    const channel = store.channels.get(session, id);
    if (!has(permissionsOf(user, channel), "VIEW_CHANNEL")) {
      throw new ProtocolError("not_found", `${personIn(session, user).name} can't see channel ${id}`, { channel: id });
    }
    return channel;
  };

  const mayWrite = (session: string, user: string, channel: DiscordChannelRecord) => {
    const permissions = permissionsOf(user, channel);
    const needed: Permission = channel.kind === "public_thread" ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES";
    if (!has(permissions, needed))
      throw new DiscordRefusal(50013, { message: `${personIn(session, user).name} may not write here` });
  };

  const findMessage = (session: string, ref: DiscordMessageRef): DiscordMessageRecord => {
    store.channels.get(session, ref.channel);
    const message = store.findMessage(ref.channel, ref.id);
    if (!message)
      throw new ProtocolError("not_found", `No message ${ref.id} in channel ${ref.channel}`, { message: ref.id });
    return message;
  };

  const personPosts = (
    session: string,
    user: string,
    channel: DiscordChannelRecord,
    input: DiscordMessageInput,
    replyTo?: string,
  ) => {
    mayWrite(session, user, channel);
    const { content } = mentionText(session, input.content ?? "");
    const embeds = [...(input.embeds ?? [])];
    checkContent({ content, embeds });
    const message = newMessage(channel, user, { content, embeds, components: [] }, { replyTo });
    announce(message, channel);
    return message;
  };

  /** An app a test made and acts as: never the built-in one, which the agent under test acts as. */
  const scripted = (id: string): DiscordAppRecord => {
    const found = store.appOf(id) ?? store.apps.named(id);
    if (!found) throw new ProtocolError("not_found", `There is no Discord app "${id}"`, { app: id });
    if (found === app()) {
      throw new ProtocolError(
        "invalid_argument",
        `${found.name} is the built-in app, which the agent under test acts as: script another app`,
        { app: found.id },
      );
    }
    return found;
  };

  /** A bot writes where it sees the channel and may send there, as Discord refuses its own call (50001, 50013). */
  const botWrites = (
    session: string,
    by: DiscordAppRecord,
    channel: DiscordChannelRecord,
    input: DiscordMessageInput,
    replyTo?: string,
  ) => {
    requireBot(by, channel, channel.kind === "public_thread" ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES");
    const { content } = mentionText(session, input.content ?? "");
    const embeds = [...(input.embeds ?? [])];
    checkContent({ content, embeds });
    return postAsBot(channel, { content, embeds, components: [] }, { replyTo }, by);
  };

  const interactions = createInteractions(context, {
    store,
    kit,
    dispatchTo,
    app,
    guild,
    authorOf,
    userWire,
    channelWire,
    messageWire,
    permissionsOf,
    rolesOf,
    checkContent,
    postAsBot,
    newMessage,
    update,
  });

  const world: FakeDiscordWorld = {
    store,
    interactions,
    app,
    guild,
    gatewayConnections: () => gateways.of(app().name).connections(),
    authorOf,
    botPermissions,
    requireBot,
    messageWire: (message, reader) => messageWire(message, reader),
    channelWire,
    checkContent,
    rolesOf,
    guildRoles: () => [
      roleObject({ id: store.everyoneRole, name: "@everyone", permissions: EVERYONE_PERMISSIONS, position: 0 }),
      roleObject({ id: store.adminRole, name: "Admin", permissions: ADMIN_PERMISSIONS, position: 2 }),
      // Each app's bot has the role Discord made for it when it joined.
      ...store.apps.all().map((bot) =>
        roleObject({
          id: bot.roleId,
          name: bot.name,
          permissions: BOT_PERMISSIONS,
          position: 1,
          managed: bot.botUserId,
        }),
      ),
    ],
    postAsBot,
    update,
    remove,
    reactAs,
    threadAs,
    dmWith,
    typing,
    dispatchTo,
    sessionOf,
    mentionText,
    apps: () => store.apps.all(),
    appOf: (id) => store.appOf(id),

    createApp(session, options) {
      const privilegedIntents = [...(options.privilegedIntents ?? defaults.privilegedIntents)];
      const by =
        session === undefined ? undefined : { session, people: store.usersOf(session).map((user) => user.name) };
      return store.apps.make(
        options.name,
        { privilegedIntents },
        () => {
          // A bot's id is in its token, as Discord's are: the app's token is made once per install, so its bot is too.
          const token = context.apps.secret(options.name, "botToken");
          const id = botIdOf(token);
          if (id === undefined) throw new Error(`The Discord app "${options.name}" has a token without a bot id`);
          return {
            id,
            name: options.name,
            botUserId: id,
            roleId: context.apps.ids(options.name).next(DISCORD_IDS.role),
            privilegedIntents,
          };
        },
        by,
      );
    },

    sayAsApp(session, name, input, where) {
      const by = scripted(name);
      if ("channel" in where) return botWrites(session, by, store.channels.get(session, where.channel), input);
      const [other, ...more] = where.to;
      if (other === undefined || more.length > 0) {
        throw new ProtocolError("invalid_argument", "A DM is with one other: a person");
      }
      // Discord lets no bot open a DM with another bot: an app's, or a person's kind of bot.
      if (store.appOf(other) || store.users.find(other)?.bot) throw new DiscordRefusal(50007);
      return botWrites(session, by, dmWith(personIn(session, other).id, by), input);
    },

    replyAsApp(session, name, input, to) {
      const by = scripted(name);
      const message = findMessage(session, to);
      return botWrites(session, by, store.channels.get(session, to.channel), input, message.id);
    },

    reactAsApp(session, name, emoji, ref, direction) {
      const by = scripted(name);
      const message = findMessage(session, ref);
      const channel = store.channels.get(session, ref.channel);
      requireBot(by, channel, "READ_MESSAGE_HISTORY");
      if (direction === "add" && !message.reactions.some((reaction) => reaction.emoji === emoji)) {
        requireBot(by, channel, "ADD_REACTIONS");
      }
      return reactAs(message, by.botUserId, emoji, direction);
    },

    createUser(session, options: DiscordUserOptions) {
      store.apps.checkPerson(session, options.name);
      const id = options.id === undefined ? ids.next(DISCORD_IDS.user) : ids.reserve(DISCORD_IDS.user, options.id);
      const username = options.name.toLowerCase().replace(/[^a-z0-9._]/g, "") || "user";
      return store.users.add(
        id,
        {
          id,
          name: options.name,
          username,
          admin: options.admin === true,
          bot: options.bot === true,
          fixedId: options.id !== undefined,
        },
        session,
      );
    },
    user: (session, id) => personIn(session, id),
    users: (session) => store.usersOf(session),

    createChannel(session, options: DiscordChannelOptions) {
      for (const participant of options.participants) {
        if (!store.appOf(participant)) personIn(session, participant);
      }
      const id = discordSnowflake(ids);
      const channel = store.addChannel(
        {
          id,
          kind: "text",
          name: options.name ?? `test-${id.slice(-6)}`,
          members: new Set(options.participants),
          readOnly: options.readOnly === true,
          topic: options.topic,
          createdAt: clock(),
        },
        session,
      );
      // Discord tells everyone who can see a new channel; a bot only if it is among them.
      broadcast(channel, "CHANNEL_CREATE", (reader) => channelWire(channel, reader), "GUILDS");
      return channel;
    },
    channel: (session, id) => store.channels.get(session, id),
    channels: (session) => store.channelsOf(session),

    say(session, user, input, where: DiscordWhere) {
      personIn(session, user);
      if ("channel" in where) return personPosts(session, user, visibleTo(session, user, where.channel), input);
      const [other, ...more] = where.to;
      if (other === undefined || more.length > 0) {
        throw new ProtocolError("invalid_argument", "A DM is with one other: the app, or one person");
      }
      return personPosts(session, user, world.openDM(session, user, other) as DiscordChannelRecord, input);
    },

    reply(session, user, input, to) {
      const message = findMessage(session, to);
      return personPosts(session, user, visibleTo(session, user, to.channel), input, message.id);
    },

    edit(session, user, input, ref) {
      const message = findMessage(session, ref);
      if (message.authorId !== user) throw new DiscordRefusal(50005);
      const { content } = mentionText(session, input.content ?? message.content);
      const embeds = input.embeds === undefined ? message.embeds : [...input.embeds];
      checkContent({ content, embeds });
      return update(message, { content, embeds });
    },

    delete(session, user, ref) {
      const message = findMessage(session, ref);
      const channel = store.channels.get(session, ref.channel);
      if (message.authorId !== user && !has(permissionsOf(user, channel), "MANAGE_MESSAGES"))
        throw new DiscordRefusal(50013);
      remove(message);
    },

    react(session, user, emoji, ref, direction) {
      const message = findMessage(session, ref);
      const channel = visibleTo(session, user, ref.channel);
      if (
        direction === "add" &&
        !has(permissionsOf(user, channel), "ADD_REACTIONS") &&
        !message.reactions.some((r) => r.emoji === emoji)
      ) {
        throw new DiscordRefusal(50013);
      }
      return reactAs(message, user, emoji, direction);
    },

    startThread(session, user, name, from) {
      const parentId = "message" in from ? from.message.channel : from.channel;
      const parent = visibleTo(session, user, parentId);
      if (parent.kind !== "text")
        throw new ProtocolError("invalid_argument", "Threads are started in a guild's text channel");
      if (!has(permissionsOf(user, parent), "CREATE_PUBLIC_THREADS")) throw new DiscordRefusal(50013);
      const starter = "message" in from ? findMessage(session, from.message) : undefined;
      return threadAs(user, parent, name, starter);
    },

    openDM(session, user, other) {
      personIn(session, user);
      const bot = store.appOf(other);
      if (bot) return dmWith(user, bot);
      const person = personIn(session, other);
      const key = [user, person.id].sort().join(":");
      const existing = store.dms.get(key);
      if (existing !== undefined) return store.channels.get(session, existing);
      const channel = store.addChannel(
        {
          id: discordSnowflake(ids),
          kind: "dm",
          name: undefined,
          members: new Set([user, person.id]),
          readOnly: false,
          createdAt: clock(),
        },
        session,
      );
      store.dms.set(key, channel.id);
      return channel;
    },

    invite(session, user, participants, id) {
      const channel = visibleTo(session, user, id);
      if (channel.kind !== "text")
        throw new ProtocolError("invalid_argument", "People are added to a guild's text channel");
      if (
        !has(permissionsOf(user, channel), "ADMINISTRATOR") &&
        !has(permissionsOf(user, channel), "MANAGE_CHANNELS")
      ) {
        throw new DiscordRefusal(50013, {
          message: `${personIn(session, user).name} may not change who sees this channel`,
        });
      }
      const before = new Set(store.apps.all().filter((bot) => botSees(channel, bot)));
      for (const participant of participants) {
        if (!store.appOf(participant)) personIn(session, participant);
        channel.members.add(participant);
      }
      // The channel's overwrites changed: whoever sees it hears CHANNEL_UPDATE, a bot too once it may.
      broadcast(
        channel,
        "CHANNEL_UPDATE",
        (reader) => channelWire(channel, reader),
        "GUILDS",
        (reader) => before.has(reader) || botSees(channel, reader),
      );
    },

    runCommand(session, user, command, channel, appId) {
      const only = appId === undefined ? undefined : (store.appOf(appId) ?? store.apps.named(appId));
      if (appId !== undefined && !only)
        throw new ProtocolError("not_found", `There is no Discord app "${appId}"`, { app: appId });
      return interactions.command(session, user, command, visibleTo(session, user, channel), only);
    },

    click(session, user, button: DiscordButtonRef, where: DiscordControlWhere) {
      const message =
        "message" in where
          ? findMessage(session, where.message)
          : interactions.latestWith(user, visibleTo(session, user, where.channel), button);
      visibleTo(session, user, message.channelId);
      return interactions.click(session, user, button, message);
    },

    messages(session, id) {
      store.channels.get(session, id);
      return store.messagesIn(id).filter((message) => message.ephemeralFor === undefined && !message.system);
    },
    message: (session, channel, id) => findMessage(session, { channel, id }),
    replies(session, channel, id) {
      const message = findMessage(session, { channel, id });
      const inline = store
        .messagesIn(channel)
        .filter((other) => other.replyTo === message.id && other.ephemeralFor === undefined && !other.system);
      const thread =
        message.threadId === undefined
          ? []
          : store.messagesIn(message.threadId).filter((other) => other.ephemeralFor === undefined && !other.system);
      return [...inline, ...thread].sort((a, b) => a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },
    threads(session, channel) {
      store.channels.get(session, channel);
      return store.channelsOf(session).filter((other) => other.kind === "public_thread" && other.parentId === channel);
    },
    ephemeral(session, user) {
      personIn(session, user);
      return store
        .channelsOf(session)
        .flatMap((channel) => store.messagesIn(channel.id))
        .filter((message) => message.ephemeralFor === user);
    },

    deliveries: (session) => kit.deliveries(session),
    delivery: (session, id) => kit.delivery(session, id),
    resend: (session, id, options) => kit.resend(session, id, options),
    redeliver: (session, id) => kit.redeliver(session, id),

    addFault(session, fault) {
      // Each session's faults are its own: a drop fires before that session's next dispatch, and undo or the session's end removes it.
      const id = discordSnowflake(ids);
      store.faults.push({ ...fault, id, session });
      return id;
    },
    removeFault(session, id) {
      const at = store.faults.findIndex((fault) => fault.id === id && fault.session === session);
      if (at >= 0) store.faults.splice(at, 1);
    },

    openWork: (session) => interactions.openWork(session),
  };
  return world;
}
