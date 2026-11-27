import type { DiscordChannelRecord } from "./world.ts";

/** Discord's permission bits, the ones the fake checks or hands out. */
export const PERMISSIONS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export type Permission = keyof typeof PERMISSIONS;

const ALL = Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0n);

/** What `@everyone` may do in the guild: a community server's defaults. */
export const EVERYONE_PERMISSIONS =
  PERMISSIONS.CREATE_INSTANT_INVITE |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.READ_MESSAGE_HISTORY |
  PERMISSIONS.USE_EXTERNAL_EMOJIS |
  PERMISSIONS.USE_APPLICATION_COMMANDS |
  PERMISSIONS.CREATE_PUBLIC_THREADS |
  PERMISSIONS.SEND_MESSAGES_IN_THREADS;

/**
 * What the bot's own role may do: what a conversational bot's invite link asks for. Not
 * `MANAGE_MESSAGES`: deleting someone else's message is refused, as for most bots.
 */
export const BOT_PERMISSIONS =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.SEND_MESSAGES_IN_THREADS |
  PERMISSIONS.CREATE_PUBLIC_THREADS |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.READ_MESSAGE_HISTORY |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.USE_EXTERNAL_EMOJIS |
  PERMISSIONS.USE_APPLICATION_COMMANDS;

/** The `Admin` role people made with `admin: true` have. */
export const ADMIN_PERMISSIONS = PERMISSIONS.ADMINISTRATOR;

/** One permission overwrite on a channel, as Discord sends it: type 0 for a role, 1 for a member. */
export interface Overwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: bigint;
  readonly deny: bigint;
}

/**
 * A channel's overwrites: a test's channel is private to its participants, as a private channel
 * is made in Discord (`@everyone` may not view it, each participant may), and read-only for
 * everyone who isn't an admin.
 */
export function overwritesOf(channel: DiscordChannelRecord, everyoneRole: string): Overwrite[] {
  if (channel.kind !== "text") return [];
  const everyone: Overwrite = {
    id: everyoneRole,
    type: 0,
    allow: 0n,
    deny: PERMISSIONS.VIEW_CHANNEL | (channel.readOnly ? PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ADD_REACTIONS : 0n),
  };
  return [
    everyone,
    ...[...channel.members].map((id): Overwrite => ({ id, type: 1, allow: PERMISSIONS.VIEW_CHANNEL, deny: 0n })),
  ];
}

/**
 * What a member may do in a channel, as Discord computes it: the guild's `@everyone`, then their
 * roles; an administrator may do everything; then the channel's overwrites, `@everyone`'s first,
 * the roles', then the member's own.
 */
export function permissionsIn(
  member: { readonly id: string; readonly roles: ReadonlyArray<{ readonly id: string; readonly permissions: bigint }> },
  everyone: { readonly id: string; readonly permissions: bigint },
  overwrites: readonly Overwrite[],
): bigint {
  let permissions = member.roles.reduce((all, role) => all | role.permissions, everyone.permissions);
  if ((permissions & PERMISSIONS.ADMINISTRATOR) !== 0n) return ALL;
  const apply = (overwrite: Overwrite | undefined) => {
    if (overwrite) permissions = (permissions & ~overwrite.deny) | overwrite.allow;
  };
  apply(overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === everyone.id));
  const roles = overwrites.filter(
    (overwrite) => overwrite.type === 0 && member.roles.some((r) => r.id === overwrite.id),
  );
  apply({
    id: "",
    type: 0,
    allow: roles.reduce((all, overwrite) => all | overwrite.allow, 0n),
    deny: roles.reduce((all, overwrite) => all | overwrite.deny, 0n),
  });
  apply(overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.id));
  return permissions;
}

export const has = (permissions: bigint, permission: Permission) => (permissions & PERMISSIONS[permission]) !== 0n;
