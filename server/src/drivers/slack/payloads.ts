import { richTextElements } from "./mrkdwn.ts";
import type {
  SlackAppRecord,
  SlackConversationRecord,
  SlackFileRecord,
  SlackMessageRecord,
  SlackTeam,
  SlackUserRecord,
} from "./world.ts";

/** Builders for every payload Slack sends an app. Shapes follow https://docs.slack.dev/reference/events. */

const CHANNEL_TYPE = { channel: "channel", private_channel: "group", im: "im", mpim: "mpim" } as const;

/** The event subscription a message in this kind of conversation needs: `message.channels`, `message.im`, … */
export function messageSubscription(conversation: SlackConversationRecord): string {
  return { channel: "message.channels", private_channel: "message.groups", im: "message.im", mpim: "message.mpim" }[
    conversation.kind
  ];
}

/**
 * Slack's `rich_text` block of a message's text, for a message sent without blocks (a person's, or
 * the app's): its mrkdwn as Slack's elements (`mrkdwn.ts`).
 */
export function richTextBlock(text: string, blockId: string): unknown {
  return { type: "rich_text", block_id: blockId, elements: richTextElements(text) };
}

/** The app's bot as Slack describes it on each message the app posted. */
function botProfile(app: SlackAppRecord, team: SlackTeam): Record<string, unknown> {
  const icon = (size: number) => `https://a.slack-edge.com/80588/img/plugins/app/bot_${size}.png`;
  return {
    id: app.botId,
    deleted: false,
    name: app.name,
    updated: app.updated ?? 0,
    app_id: app.id,
    user_id: app.botUserId,
    icons: { image_36: icon(36), image_48: icon(48), image_72: icon(72) },
    team_id: team.id,
  };
}

/** A message as it appears in events and in `conversations.history`. */
export function messageObject(
  message: SlackMessageRecord,
  author: SlackUserRecord | undefined,
  team: SlackTeam,
  app: SlackAppRecord,
): Record<string, unknown> {
  const fromApp = message.user === app.botUserId;
  return {
    type: "message",
    user: message.user,
    text: message.text,
    ts: message.ts,
    team: team.id,
    blocks: message.blocks,
    ...(message.threadTs === undefined ? {} : { thread_ts: message.threadTs }),
    ...(message.edited === undefined ? {} : { edited: { user: message.user, ts: message.edited } }),
    ...(fromApp
      ? { bot_id: app.botId, app_id: app.id, bot_profile: botProfile(app, team) }
      : author?.botId
        ? { bot_id: author.botId }
        : {}),
    ...(message.parentUser === undefined ? {} : { parent_user_id: message.parentUser }),
    ...(message.reactions.length === 0
      ? {}
      : { reactions: message.reactions.map(({ name, users }) => ({ name, users, count: users.length })) }),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    // A reply that was also sent to the channel says so.
    ...(message.broadcast ? { subtype: "thread_broadcast" } : {}),
    // A message that shares files says so, and carries them.
    ...(message.files.length === 0
      ? {}
      : { subtype: "file_share", upload: false, files: message.files.map((file) => fileObject(file)) }),
  };
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
};

/** A file as Slack describes it in messages and `files.info`. */
export function fileObject(file: SlackFileRecord): Record<string, unknown> {
  const filetype = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "binary";
  return {
    id: file.id,
    created: file.created,
    timestamp: file.created,
    name: file.name,
    title: file.title,
    mimetype: MIME_TYPES[filetype] ?? "application/octet-stream",
    filetype,
    user: file.user,
    size: file.size,
    mode: "hosted",
    is_external: false,
    is_public: false,
  };
}

export function messageEvent(
  message: SlackMessageRecord,
  conversation: SlackConversationRecord,
  author: SlackUserRecord | undefined,
  team: SlackTeam,
  app: SlackAppRecord,
): Record<string, unknown> {
  return {
    ...messageObject(message, author, team, app),
    channel: conversation.id,
    channel_type: CHANNEL_TYPE[conversation.kind],
    event_ts: message.ts,
  };
}

export function appMentionEvent(
  message: SlackMessageRecord,
  conversation: SlackConversationRecord,
  author: SlackUserRecord | undefined,
  team: SlackTeam,
): Record<string, unknown> {
  return {
    type: "app_mention",
    user: message.user,
    text: message.text,
    ts: message.ts,
    channel: conversation.id,
    event_ts: message.ts,
    team: team.id,
    blocks: message.blocks,
    ...(message.threadTs === undefined ? {} : { thread_ts: message.threadTs }),
    // A mention written by another bot says so, which is how an agent can ignore bots.
    ...(author?.botId === undefined ? {} : { bot_id: author.botId }),
  };
}

export function messageChangedEvent(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
  conversation: SlackConversationRecord,
  eventTs: string,
): Record<string, unknown> {
  return {
    type: "message",
    subtype: "message_changed",
    hidden: true,
    message: current,
    previous_message: previous,
    channel: conversation.id,
    channel_type: CHANNEL_TYPE[conversation.kind],
    ts: eventTs,
    event_ts: eventTs,
  };
}

export function messageDeletedEvent(
  previous: Record<string, unknown>,
  conversation: SlackConversationRecord,
  eventTs: string,
): Record<string, unknown> {
  return {
    type: "message",
    subtype: "message_deleted",
    hidden: true,
    deleted_ts: previous.ts,
    previous_message: previous,
    channel: conversation.id,
    channel_type: CHANNEL_TYPE[conversation.kind],
    ts: eventTs,
    event_ts: eventTs,
  };
}

export function reactionEvent(
  action: "add" | "remove",
  input: { user: string; reaction: string; message: SlackMessageRecord; eventTs: string },
): Record<string, unknown> {
  return {
    type: action === "add" ? "reaction_added" : "reaction_removed",
    user: input.user,
    reaction: input.reaction,
    item: { type: "message", channel: input.message.conversation, ts: input.message.ts },
    item_user: input.message.user,
    event_ts: input.eventTs,
  };
}

export function membershipEvent(
  type: "member_joined_channel" | "member_left_channel",
  input: {
    user: string;
    conversation: SlackConversationRecord;
    team: SlackTeam;
    inviter?: string | undefined;
    eventTs: string;
  },
): Record<string, unknown> {
  return {
    type,
    user: input.user,
    channel: input.conversation.id,
    // The first letter of the channel's id. A private channel's id starts with C too, and a real
    // workspace said "C" for one (#58).
    channel_type: input.conversation.id.startsWith("G") ? "G" : "C",
    team: input.team.id,
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }),
    event_ts: input.eventTs,
  };
}

/** What Slack writes in a channel when someone joins it, or archives it. */
const CHANNEL_MESSAGE_TEXT = {
  channel_join: (user: string) => `<@${user}> has joined the channel`,
  channel_archive: () => "archived the channel",
} as const;

/**
 * The message Slack posts in a channel when someone joins it (`channel_join`, with `inviter` when
 * someone added them) or archives it (`channel_archive`). A private channel gets the same
 * subtypes, with `channel_type: "group"`. Shapes as a real workspace sent them (#58).
 */
export function channelMessageEvent(
  subtype: keyof typeof CHANNEL_MESSAGE_TEXT,
  input: { user: string; conversation: SlackConversationRecord; inviter?: string | undefined; ts: string },
): Record<string, unknown> {
  return {
    type: "message",
    subtype,
    user: input.user,
    text: CHANNEL_MESSAGE_TEXT[subtype](input.user),
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }),
    ts: input.ts,
    channel: input.conversation.id,
    event_ts: input.ts,
    channel_type: CHANNEL_TYPE[input.conversation.kind],
  };
}

/** The Events API envelope around an event (`type: "event_callback"`). */
export function eventCallback(input: {
  event: Record<string, unknown>;
  eventId: string;
  atMs: number;
  team: SlackTeam;
  app: SlackAppRecord;
  verificationToken: string;
}): Record<string, unknown> {
  const { team, app } = input;
  return {
    token: input.verificationToken,
    team_id: team.id,
    // The workspace the event happened in, and its Enterprise Grid org (none here). Real Slack
    // sends both on every event but `app_mention` (#58).
    ...(input.event.type === "app_mention" ? {} : { context_team_id: team.id, context_enterprise_id: null }),
    api_app_id: app.id,
    event: input.event,
    type: "event_callback",
    event_id: input.eventId,
    event_time: Math.floor(input.atMs / 1000),
    authorizations: [
      { enterprise_id: null, team_id: team.id, user_id: app.botUserId, is_bot: true, is_enterprise_install: false },
    ],
    is_ext_shared_channel: false,
    event_context: `4-${Buffer.from(JSON.stringify({ et: input.event.type, tid: team.id, aid: app.id })).toString("base64url")}`,
  };
}
