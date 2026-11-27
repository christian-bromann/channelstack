import { snowflakeTime } from "./ids.ts";
import type { Overwrite } from "./permissions.ts";
import type {
  DiscordAppRecord,
  DiscordChannelRecord,
  DiscordGuildRecord,
  DiscordMessageRecord,
  DiscordUserRecord,
} from "./world.ts";

/** When the bot and the guild's people joined it: before any test. */
export const JOINED_AT = Date.parse("2026-01-01T00:00:00.000Z");

/** Discord's channel types: 0 a guild text channel, 1 a DM, 11 a public thread. */
export const CHANNEL_TYPE = { text: 0, dm: 1, public_thread: 11 } as const;

/** Discord's message flags the fake uses. */
export const MESSAGE_FLAGS = { EPHEMERAL: 1 << 6, LOADING: 1 << 7 } as const;

/** Who wrote something, as `user` objects carry it: a person, or the agent's bot. */
export type Author =
  | { readonly kind: "user"; readonly user: DiscordUserRecord }
  | { readonly kind: "app"; readonly app: DiscordAppRecord };

/** A user object, as every Discord payload carries one. */
export function userObject(author: Author): Record<string, unknown> {
  if (author.kind === "app") {
    const { app } = author;
    return {
      id: app.botUserId,
      username: app.name,
      global_name: null,
      discriminator: "0000",
      avatar: null,
      bot: true,
      system: false,
      public_flags: 0,
      flags: 0,
      banner: null,
      accent_color: null,
      avatar_decoration_data: null,
      collectibles: null,
      display_name_styles: null,
      primary_guild: null,
      clan: null,
    };
  }
  const { user } = author;
  return {
    id: user.id,
    username: user.username,
    global_name: user.bot ? null : user.name,
    discriminator: user.bot ? "0001" : "0",
    avatar: null,
    ...(user.bot ? { bot: true } : {}),
    public_flags: 0,
    flags: 0,
    banner: null,
    accent_color: null,
    avatar_decoration_data: null,
    collectibles: null,
    display_name_styles: null,
    primary_guild: null,
    clan: null,
  };
}

/** A guild member, without its user: what a guild message carries as `member`. */
export function memberObject(roles: readonly string[], joinedAt: number): Record<string, unknown> {
  return {
    roles: [...roles],
    nick: null,
    avatar: null,
    banner: null,
    premium_since: null,
    joined_at: new Date(joinedAt).toISOString(),
    deaf: false,
    mute: false,
    pending: false,
    flags: 0,
    communication_disabled_until: null,
  };
}

const overwriteObject = (overwrite: Overwrite) => ({
  id: overwrite.id,
  type: overwrite.type,
  allow: overwrite.allow.toString(),
  deny: overwrite.deny.toString(),
});

/** A channel, a DM or a thread, as `GET /channels/{id}` and the Gateway give it. */
export function channelObject(
  channel: DiscordChannelRecord,
  context: {
    guild: DiscordGuildRecord;
    overwrites: readonly Overwrite[];
    /** A DM's other end, as the bot sees it. */
    recipients?: readonly Record<string, unknown>[];
    lastMessageId: string | null;
    messageCount: number;
  },
): Record<string, unknown> {
  if (channel.kind === "dm") {
    return {
      id: channel.id,
      type: CHANNEL_TYPE.dm,
      last_message_id: context.lastMessageId,
      flags: 0,
      recipients: [...(context.recipients ?? [])],
    };
  }
  const common = {
    id: channel.id,
    type: CHANNEL_TYPE[channel.kind],
    guild_id: context.guild.id,
    name: channel.name ?? "",
    last_message_id: context.lastMessageId,
    rate_limit_per_user: 0,
    flags: 0,
  };
  if (channel.kind === "public_thread") {
    return {
      ...common,
      parent_id: channel.parentId,
      owner_id: channel.ownerId,
      message_count: context.messageCount,
      member_count: 1,
      total_message_sent: context.messageCount,
      thread_metadata: {
        archived: false,
        archive_timestamp: new Date(channel.createdAt).toISOString(),
        auto_archive_duration: 1440,
        locked: false,
        create_timestamp: new Date(channel.createdAt).toISOString(),
      },
    };
  }
  return {
    ...common,
    position: 0,
    permission_overwrites: context.overwrites.map(overwriteObject),
    parent_id: null,
    topic: channel.topic ?? null,
    nsfw: false,
    last_pin_timestamp: null,
  };
}

/** A reaction as a message lists it. */
const reactionObject = (emoji: string, count: number, me: boolean) => ({
  emoji: { id: null, name: emoji },
  count,
  count_details: { burst: 0, normal: count },
  burst_colors: [],
  me_burst: false,
  burst_me: false,
  me,
  burst_count: 0,
});

/** What a message needs from the world to be written out: who its people are, and what it refers to. */
export interface MessageContext {
  author: Author;
  /** The users it mentions. */
  mentions: readonly Record<string, unknown>[];
  /** The message it replies to, written out without its own reference. */
  referenced?: Record<string, unknown> | null | undefined;
  /** The thread started from it. */
  thread?: Record<string, unknown>;
  guildId: string | undefined;
  /** The bot reading it: what `me` means on its reactions. */
  reader: string;
  /** The app, for a response to an interaction (`webhook_id`, `application_id`). */
  applicationId?: string;
  /** For a response to an interaction: who started it. */
  interactionUser?: Record<string, unknown> | undefined;
}

/** A message as REST answers it. */
export function messageObject(message: DiscordMessageRecord, context: MessageContext): Record<string, unknown> {
  const reference =
    message.replyTo === undefined
      ? {}
      : {
          message_reference: {
            type: 0,
            channel_id: message.channelId,
            message_id: message.replyTo,
            ...(context.guildId ? { guild_id: context.guildId } : {}),
          },
          referenced_message: context.referenced ?? null,
        };
  const interaction =
    message.interaction === undefined
      ? {}
      : {
          webhook_id: context.applicationId,
          application_id: context.applicationId,
          interaction_metadata: {
            id: message.interaction.id,
            type: message.interaction.type,
            user: context.interactionUser ?? { id: message.interaction.userId },
            authorizing_integration_owners: { 0: context.guildId ?? "0" },
            ...(message.interaction.name ? { name: message.interaction.name, command_type: 1 } : {}),
            ...(message.interaction.messageId ? { interacted_message_id: message.interaction.messageId } : {}),
          },
        };
  return {
    type: message.type,
    content: message.content,
    mentions: [...context.mentions],
    mention_roles: [],
    attachments: [],
    embeds: [...message.embeds],
    timestamp: snowflakeTime(message.id).replace("Z", "+00:00"),
    edited_timestamp:
      message.editedAt === undefined ? null : new Date(message.editedAt).toISOString().replace("Z", "+00:00"),
    flags: message.flags,
    components: [...message.components],
    id: message.id,
    channel_id: message.channelId,
    author: userObject(context.author),
    pinned: false,
    mention_everyone: false,
    tts: false,
    ...(message.reactions.length === 0
      ? {}
      : {
          reactions: message.reactions.map((reaction) =>
            reactionObject(reaction.emoji, reaction.users.length, reaction.users.includes(context.reader)),
          ),
        }),
    ...reference,
    ...interaction,
    ...(context.thread ? { thread: context.thread } : {}),
  };
}

/**
 * A message as the Gateway dispatches it: the REST object, with the guild and its author as a
 * member there, and each mention's member too.
 */
export function messageDispatch(
  object: Record<string, unknown>,
  context: { guildId: string | undefined; member: Record<string, unknown> | undefined; channelType: number },
): Record<string, unknown> {
  return {
    ...object,
    channel_type: context.channelType,
    ...(context.guildId ? { guild_id: context.guildId } : {}),
    ...(context.member ? { member: context.member } : {}),
  };
}

/**
 * What the Gateway leaves of a message for a bot without the `MESSAGE_CONTENT` intent: no
 * content, embeds, attachments or components, unless it is the bot's own, a DM, or mentions it.
 */
export function withoutContent(object: Record<string, unknown>): Record<string, unknown> {
  return { ...object, content: "", embeds: [], attachments: [], components: [] };
}

/** A role, as the guild lists them. */
export function roleObject(role: {
  id: string;
  name: string;
  permissions: bigint;
  position: number;
  managed?: string;
}): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    description: null,
    permissions: role.permissions.toString(),
    position: role.position,
    color: 0,
    colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
    hoist: false,
    managed: role.managed !== undefined,
    mentionable: false,
    icon: null,
    unicode_emoji: null,
    flags: 0,
    ...(role.managed !== undefined ? { tags: { bot_id: role.managed } } : {}),
  };
}

/** The guild, as `GET /guilds/{id}` answers it. */
export function guildObject(
  guild: DiscordGuildRecord,
  roles: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id: guild.id,
    name: guild.name,
    icon: null,
    description: null,
    home_header: null,
    splash: null,
    discovery_splash: null,
    features: [],
    banner: null,
    owner_id: guild.ownerId,
    application_id: null,
    region: "deprecated",
    afk_channel_id: null,
    afk_timeout: 300,
    system_channel_id: null,
    system_channel_flags: 0,
    widget_enabled: false,
    widget_channel_id: null,
    verification_level: 0,
    roles: [...roles],
    default_message_notifications: 1,
    mfa_level: 0,
    explicit_content_filter: 0,
    max_presences: null,
    max_members: 25_000_000,
    max_stage_video_channel_users: 50,
    max_video_channel_users: 25,
    vanity_url_code: null,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: "en-US",
    rules_channel_id: null,
    safety_alerts_channel_id: null,
    public_updates_channel_id: null,
    premium_progress_bar_enabled: false,
    premium_progress_bar_enabled_user_updated_at: null,
    // A Student Hub's type; a guild that isn't one has none.
    hub_type: null,
    nsfw: false,
    nsfw_level: 0,
    emojis: [],
    stickers: [],
    incidents_data: null,
    inventory_settings: null,
    embed_enabled: false,
    embed_channel_id: null,
  };
}

/** The application, as `GET /applications/@me` answers it to its bot. */
export function applicationObject(
  app: DiscordAppRecord,
  context: { publicKey: string; flags: number; interactionsUrl: string | undefined; guilds: number },
): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    icon: null,
    description: "",
    type: null,
    bot: userObject({ kind: "app", app }),
    bot_public: true,
    bot_require_code_grant: false,
    verify_key: context.publicKey,
    flags: context.flags,
    flags_new: String(context.flags),
    summary: "",
    is_monetized: false,
    is_verified: false,
    is_discoverable: false,
    hook: true,
    storefront_available: false,
    integration_types_config: { 0: {} },
    redirect_uris: [],
    interactions_endpoint_url: context.interactionsUrl ?? null,
    role_connections_verification_url: null,
    // A bot's application belongs to the person who made it; the fake's to its guild's owner.
    owner: {
      id: "0",
      username: "acme",
      avatar: null,
      discriminator: "0",
      public_flags: 0,
      flags: 0,
      global_name: "Acme",
      primary_guild: null,
    },
    approximate_guild_count: context.guilds,
    approximate_user_install_count: 0,
    approximate_user_authorization_count: 0,
    explicit_content_filter: 0,
    team: null,
    eligible_oauth2_scopes: ["applications.commands", "bot"],
  };
}

/** The flags an application has for the privileged intents switched on in the developer portal. */
export function applicationFlags(privileged: readonly string[]): number {
  const flags: Record<string, number> = {
    GUILD_PRESENCES: 1 << 13,
    GUILD_MEMBERS: 1 << 15,
    MESSAGE_CONTENT: 1 << 19,
  };
  return privileged.reduce((all, intent) => all | (flags[intent] ?? 0), 0);
}

/**
 * A message's components as Discord keeps them: each one, rows and what is in them, with an `id`,
 * numbered in order from 1 where the app gave none, as Discord numbers them.
 */
export function numbered(components: readonly unknown[]): unknown[] {
  let next = 1;
  const taken = new Set<number>();
  const collect = (list: readonly unknown[]) => {
    for (const raw of list) {
      const component = raw as { id?: unknown; components?: unknown };
      if (typeof component.id === "number") taken.add(component.id);
      if (Array.isArray(component.components)) collect(component.components);
    }
  };
  collect(components);
  const number = (list: readonly unknown[]): unknown[] =>
    list.map((raw) => {
      if (typeof raw !== "object" || raw === null) return raw;
      const component = raw as Record<string, unknown>;
      let id = component.id;
      if (typeof id !== "number") {
        while (taken.has(next)) next += 1;
        id = next;
        taken.add(next);
      }
      return {
        ...component,
        id,
        ...(Array.isArray(component.components) ? { components: number(component.components) } : {}),
      };
    });
  return number(components);
}
