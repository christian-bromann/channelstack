import { Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import { delay } from "../../../core/clock/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { recordCall } from "../../../core/router/inspect.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { identified } from "../blocks.ts";
import { SLACK_IDS, slackTs } from "../ids.ts";
import { handleOf } from "../interaction-payloads.ts";
import { fileObject, membershipEvent, messageObject } from "../payloads.ts";
import {
  NOBODY,
  type SlackConversationRecord,
  type SlackMessageRecord,
  SlackRefusal,
  type SlackUserRecord,
} from "../world.ts";
import type { SocketMode } from "./socket.ts";
import type { SlackStore } from "./store.ts";
import type { FakeSlackWorld } from "./world.ts";

/** A Web API refusal: Slack answers 200 with `{ ok: false, error }`. */
class SlackApiError extends Error {
  readonly extra: Record<string, unknown>;

  constructor(code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.extra = extra;
  }
}

type Args = Record<string, unknown>;
type Method = (args: Args) => Record<string, unknown>;

/** Slack's limits (https://docs.slack.dev/reference/methods/chat.postMessage, chat.startStream). */
const MAX_STREAM_LENGTH = 12_000;
/** The fake keeps uploads in memory, so it takes small files only. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** How long after Retry-After a retry may still come: clients add their own backoff (Slack's WebClient: 1 to 2 seconds). */
const RETRY_GRACE_MS = 3000;
const SESSION_STATUSES = ["active", "processing", "suspended", "closed"] as const;

/** The scope each method needs. A method that isn't listed needs none beyond a valid token. */
const SCOPES: Readonly<Record<string, readonly string[]>> = {
  "chat.postMessage": ["chat:write"],
  "chat.update": ["chat:write"],
  "chat.delete": ["chat:write"],
  "chat.postEphemeral": ["chat:write"],
  "chat.startStream": ["chat:write"],
  "chat.appendStream": ["chat:write"],
  "chat.stopStream": ["chat:write"],
  "assistant.threads.setStatus": ["chat:write", "assistant:write"],
  "assistant.threads.setTitle": ["assistant:write"],
  "assistant.threads.setSuggestedPrompts": ["assistant:write"],
  "agents.sessions.setStatus": ["chat:write"],
  "agents.sessions.rename": ["chat:write"],
  "files.getUploadURLExternal": ["files:write"],
  "files.completeUploadExternal": ["files:write"],
  "files.info": ["files:read"],
  "reactions.add": ["reactions:write"],
  "reactions.remove": ["reactions:write"],
  "reactions.get": ["reactions:read"],
  "users.info": ["users:read"],
  "users.list": ["users:read"],
  "conversations.join": ["channels:join"],
};

const string = (args: Args, name: string): string | undefined => {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const required = (args: Args, name: string): string => {
  const value = string(args, name);
  if (value === undefined)
    throw new SlackApiError("invalid_arguments", {
      response_metadata: { messages: [`[ERROR] missing required field: ${name}`] },
    });
  return value;
};

/** A JSON argument: Slack accepts it as a value in a JSON body, or as a string in a form body. */
const json = (args: Args, name: string): unknown => {
  const value = args[name];
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new SlackApiError("invalid_arguments");
  }
};

/**
 * The Slack Web API, as the agent sees it: `POST /api/<method>` with a JSON or form body and the
 * bot token. It refuses what Slack refuses, with Slack's error codes, and records every call
 * about a conversation for the session that owns it.
 */
export function createSlackApi(
  context: DriverContext,
  store: SlackStore,
  world: FakeSlackWorld,
  socket: SocketMode,
): Hono {
  const { ids, clock } = context;
  const bot = () => store.app.botUserId;

  const userObject = (user: SlackUserRecord) => ({
    id: user.id,
    team_id: store.team.id,
    name: handleOf(user),
    deleted: false,
    real_name: user.realName,
    tz: user.timezone,
    profile: {
      real_name: user.realName,
      display_name: user.displayName,
      ...(user.email === undefined ? {} : { email: user.email }),
      team: store.team.id,
    },
    is_admin: user.isAdmin,
    is_owner: user.isOwner,
    is_restricted: user.isGuest,
    is_bot: user.isBot,
    is_app_user: false,
  });

  const appUserObject = () => ({
    id: bot(),
    team_id: store.team.id,
    name: store.app.name,
    deleted: false,
    real_name: store.app.name,
    tz: "America/Los_Angeles",
    profile: {
      real_name: store.app.name,
      display_name: store.app.name,
      bot_id: store.app.botId,
      api_app_id: store.app.id,
      team: store.team.id,
    },
    is_admin: false,
    is_owner: false,
    is_restricted: false,
    is_bot: true,
    is_app_user: false,
  });

  /** A conversation as Slack describes it; `info` adds what only `conversations.info` says (`last_read`). */
  const conversationObject = (conversation: SlackConversationRecord, info = false) => {
    if (conversation.kind === "im") {
      const [other] = [...conversation.members].filter((id) => id !== bot());
      return {
        id: conversation.id,
        created: conversation.created,
        is_im: true,
        is_org_shared: false,
        user: other,
        is_user_deleted: false,
      };
    }
    return {
      id: conversation.id,
      name: conversation.name ?? `mpdm-${conversation.id.toLowerCase()}`,
      is_channel: conversation.kind === "channel",
      is_group: conversation.kind === "private_channel",
      is_im: false,
      is_mpim: conversation.kind === "mpim",
      is_private: conversation.kind !== "channel",
      created: conversation.created,
      creator: conversation.creator,
      is_archived: conversation.isArchived,
      is_member: conversation.members.has(bot()),
      topic: { value: conversation.topic, creator: conversation.creator, last_set: conversation.created },
      purpose: { value: conversation.purpose, creator: conversation.creator, last_set: conversation.created },
      num_members: conversation.members.size,
      // One workspace, shared with no other: what Slack says of such a channel.
      is_shared: false,
      is_ext_shared: false,
      is_org_shared: false,
      is_pending_ext_shared: false,
      is_general: conversation.name === "general",
      context_team_id: store.team.id,
      shared_team_ids: [store.team.id],
      pending_shared: [],
      pending_connected_team_ids: [],
      name_normalized: conversation.name ?? `mpdm-${conversation.id.toLowerCase()}`,
      previous_names: [],
      parent_conversation: null,
      unlinked: 0,
      // Milliseconds, unlike `created`.
      updated: conversation.created * 1000,
      properties: {},
      ...(info && conversation.members.has(bot()) ? { last_read: "0000000000.000000" } : {}),
    };
  };

  const messageOf = (message: SlackMessageRecord) =>
    messageObject(message, store.users.find(message.user), store.team, store.app);

  /** A conversation the app may read and write: it exists, and the app is a member. */
  const joined = (id: string): SlackConversationRecord => {
    let conversation = store.conversations.find(id);
    // Posting to a user id opens the DM with that person, as Slack does.
    const person = conversation ? undefined : store.users.find(id);
    const owner = person ? store.users.owner(person.id) : undefined;
    if (person && owner !== undefined) conversation = world.openConversation(owner, person.id, [bot()]);
    if (!conversation) throw new SlackApiError("channel_not_found");
    if (!conversation.members.has(bot())) {
      // Slack doesn't reveal a private conversation the app isn't in.
      throw new SlackApiError(conversation.kind === "channel" ? "not_in_channel" : "channel_not_found");
    }
    if (conversation.isArchived) throw new SlackApiError("is_archived");
    return conversation;
  };

  const messageIn = (conversation: SlackConversationRecord, ts: string): SlackMessageRecord => {
    const message = store.findMessage(conversation.id, ts);
    // An ephemeral message can't be found again: Slack doesn't keep it, so nothing can edit, delete or react to it.
    if (!message || message.ephemeralFor !== undefined) throw new SlackApiError("message_not_found");
    return message;
  };

  const threadRoot = (conversation: SlackConversationRecord, ts: string | undefined): string | undefined => {
    if (ts === undefined || ts === "0") return undefined;
    const root = store.findMessage(conversation.id, ts);
    if (!root) throw new SlackApiError("thread_not_found");
    return root.threadTs ?? root.ts;
  };

  /** The text and blocks of a message the app sends. `blocks` is left out when it sent none: Slack then makes one of the text. */
  const text = (args: Args): { text: string; blocks?: unknown[] } => {
    const blocks = json(args, "blocks");
    const value = string(args, "text") ?? string(args, "markdown_text") ?? "";
    world.checkContent(value, Array.isArray(blocks) ? blocks : undefined);
    return Array.isArray(blocks) ? { text: value, blocks } : { text: value };
  };

  /**
   * The part of a list a history call asks for: `oldest` and `latest` bound it (exclusive unless
   * `inclusive`), `limit` cuts it, and `has_more` says whether something was cut. Paging on with
   * a cursor isn't built, so a cursor is refused instead of answered with the first page again.
   */
  const page = (args: Args, messages: SlackMessageRecord[]) => {
    if (string(args, "cursor") !== undefined) throw new SlackApiError("invalid_cursor");
    const inclusive = args.inclusive === true || args.inclusive === "true" || args.inclusive === "1";
    const oldest = string(args, "oldest") ?? "0";
    const latest = string(args, "latest");
    const after = (ts: string) => (inclusive ? Number(ts) >= Number(oldest) : Number(ts) > Number(oldest));
    const before = (ts: string) =>
      latest === undefined || (inclusive ? Number(ts) <= Number(latest) : Number(ts) < Number(latest));
    const inWindow = messages.filter((message) => after(message.ts) && before(message.ts));
    const limit = Math.max(1, Math.min(Number(args.limit ?? 100) || 100, 999));
    return { messages: inWindow.slice(0, limit), has_more: inWindow.length > limit };
  };

  /** The app answered, so its status line in that thread is cleared, as Slack does. */
  const answeredIn = (message: SlackMessageRecord) => {
    store.threadState(message.conversation, message.threadTs ?? message.ts).statusText = "";
  };

  /** The text one stream call carries: `markdown_text`, or the markdown chunks of `chunks`. */
  const streamed = (args: Args): string => {
    const chunks = json(args, "chunks");
    const markdown = string(args, "markdown_text");
    if (markdown !== undefined && chunks !== undefined)
      throw new SlackApiError("cannot_provide_both_markdown_text_and_chunks");
    if (!Array.isArray(chunks)) return markdown ?? "";
    return chunks
      .filter(
        (chunk): chunk is { type: string; text: string } =>
          chunk?.type === "markdown_text" && typeof chunk.text === "string",
      )
      .map((chunk) => chunk.text)
      .join("");
  };

  const appendToStream = (message: SlackMessageRecord, piece: string) => {
    const stream = message.stream;
    // After a person pressed Stop, the stream takes nothing more, and says why.
    if (stream?.state === "stopped") throw new SlackApiError("stopped_by_user");
    if (stream?.state !== "open") throw new SlackApiError("message_not_in_streaming_state");
    if (piece === "") return;
    if (message.text.length + piece.length > MAX_STREAM_LENGTH) throw new SlackApiError("msg_too_long");
    stream.chunks.push(piece);
    message.text += piece;
  };

  /** Name a thread: what the person sees in their list of conversations with the app. */
  const setTitle = (args: Args) => {
    const conversation = joined(required(args, "channel_id"));
    const threadTs = threadRoot(conversation, required(args, "thread_ts")) ?? required(args, "thread_ts");
    store.threadState(conversation.id, threadTs).title = required(args, "title");
    return {};
  };

  const methods: Readonly<Record<string, Method>> = {
    "api.test": (args) => ({ args }),

    "auth.test": () => ({
      url: `https://${store.team.domain}.slack.com/`,
      team: store.team.name,
      user: store.app.name,
      team_id: store.team.id,
      user_id: bot(),
      bot_id: store.app.botId,
      is_enterprise_install: false,
    }),

    "chat.postMessage": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = world.postAsApp(
        conversation,
        { ...text(args), metadata: json(args, "metadata") },
        {
          threadTs: threadRoot(conversation, string(args, "thread_ts")),
          // `reply_broadcast` also sends a thread reply to the channel. Outside a thread it means nothing.
          broadcast:
            (args.reply_broadcast === true || args.reply_broadcast === "true") &&
            string(args, "thread_ts") !== undefined,
        },
      );
      answeredIn(message);
      return { channel: conversation.id, ts: message.ts, message: messageOf(message) };
    },

    "chat.postEphemeral": (args) => {
      const conversation = joined(required(args, "channel"));
      const recipient = required(args, "user");
      if (!conversation.members.has(recipient)) throw new SlackApiError("user_not_in_channel");
      const message = world.postAsApp(conversation, text(args), {
        threadTs: threadRoot(conversation, string(args, "thread_ts")),
        ephemeralFor: recipient,
      });
      return { message_ts: message.ts };
    },

    "chat.update": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "ts"));
      if (message.user !== bot()) throw new SlackApiError("cant_update_message");
      world.edit(conversation, message, { blocks: [], ...text(args) });
      return { channel: conversation.id, ts: message.ts, text: message.text, message: messageOf(message) };
    },

    "chat.delete": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "ts"));
      if (message.user !== bot()) throw new SlackApiError("cant_delete_message");
      world.remove(conversation, message);
      return { channel: conversation.id, ts: message.ts };
    },

    "chat.startStream": (args) => {
      const conversation = joined(required(args, "channel"));
      const threadTs = threadRoot(conversation, string(args, "thread_ts"));
      // A top-level stream is only allowed where the whole channel is one session; here, in a DM.
      if (threadTs === undefined && conversation.kind !== "im") throw new SlackApiError("invalid_thread_ts");
      if (
        conversation.kind !== "im" &&
        (string(args, "recipient_user_id") === undefined || string(args, "recipient_team_id") === undefined)
      ) {
        throw new SlackApiError("invalid_arguments", {
          response_metadata: {
            messages: ["[ERROR] recipient_user_id and recipient_team_id are required when streaming to channels"],
          },
        });
      }
      const first = streamed(args);
      if (first.length > MAX_STREAM_LENGTH) throw new SlackApiError("msg_too_long");
      // A stream starts as a message with whatever text the first call carries; Slack shows it growing.
      const message = world.postAsApp(conversation, { text: first, blocks: [] }, { threadTs });
      message.stream = { state: "open", chunks: first === "" ? [] : [first], startedAt: clock(), endedAt: undefined };
      answeredIn(message);
      return { channel: conversation.id, ts: message.ts };
    },

    "chat.appendStream": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "ts"));
      appendToStream(message, streamed(args));
      return { channel: conversation.id, ts: message.ts };
    },

    "chat.stopStream": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "ts"));
      // Everything is checked before anything changes: a refused call leaves the stream open for a corrected one.
      const status = string(args, "session_status") ?? "active";
      if (!SESSION_STATUSES.some((known) => known === status)) throw new SlackApiError("invalid_arguments");
      appendToStream(message, streamed(args));
      const stream = message.stream;
      if (!stream) throw new SlackApiError("message_not_in_streaming_state");
      const blocks = json(args, "blocks");
      if (Array.isArray(blocks)) {
        message.blocks = [...message.blocks, ...identified(blocks, () => ids.next(SLACK_IDS.block))];
      }
      const metadata = json(args, "metadata");
      if (metadata !== undefined) message.metadata = metadata;
      stream.state = "completed";
      stream.endedAt = clock();
      store.threadState(conversation.id, message.threadTs ?? message.ts).sessionStatus =
        status as (typeof SESSION_STATUSES)[number];
      return { channel: conversation.id, ts: message.ts, message: messageOf(message) };
    },

    "assistant.threads.setStatus": (args) => {
      const conversation = joined(required(args, "channel_id"));
      const threadTs = threadRoot(conversation, required(args, "thread_ts")) ?? required(args, "thread_ts");
      // An empty status clears the line, so the argument must be present but may be "".
      if (typeof args.status !== "string") throw new SlackApiError("invalid_arguments");
      store.threadState(conversation.id, threadTs).statusText = args.status;
      return {};
    },

    "assistant.threads.setTitle": (args) => setTitle(args),
    // The same title under the newer name: an agent session is the thread.
    "agents.sessions.rename": (args) => setTitle(args),

    "assistant.threads.setSuggestedPrompts": (args) => {
      const conversation = joined(required(args, "channel_id"));
      const threadTs = threadRoot(conversation, required(args, "thread_ts")) ?? required(args, "thread_ts");
      const prompts = json(args, "prompts");
      const valid =
        Array.isArray(prompts) &&
        prompts.length > 0 &&
        prompts.every((prompt) => typeof prompt?.title === "string" && typeof prompt?.message === "string");
      if (!valid) throw new SlackApiError("invalid_arguments");
      store.threadState(conversation.id, threadTs).suggestedPrompts = prompts.map(({ title, message }) => ({
        title,
        message,
      }));
      return {};
    },

    "agents.sessions.setStatus": (args) => {
      const conversation = joined(required(args, "channel_id"));
      const status = required(args, "status");
      if (!SESSION_STATUSES.some((known) => known === status)) throw new SlackApiError("invalid_arguments");
      const threadTs = threadRoot(conversation, required(args, "thread_ts")) ?? required(args, "thread_ts");
      store.threadState(conversation.id, threadTs).sessionStatus = status as (typeof SESSION_STATUSES)[number];
      return { status, agent_status: status };
    },

    // Socket Mode: where to connect, with a ticket that works once.
    "apps.connections.open": () => ({ url: socket.ticket() }),

    // Modals: opened with the trigger_id of an interaction, for the person who caused it.
    "views.open": (args) => ({ view: world.openView(required(args, "trigger_id"), json(args, "view"), false) }),
    "views.push": (args) => ({ view: world.openView(required(args, "trigger_id"), json(args, "view"), true) }),
    "views.update": (args) => ({
      view: world.updateView(required(args, "view_id"), string(args, "hash"), json(args, "view")),
    }),

    // Files upload v2: ask where to upload, send the bytes there, then share the file.
    "files.getUploadURLExternal": (args) => {
      const name = required(args, "filename");
      const length = Number(args.length);
      if (!Number.isInteger(length) || length <= 0) throw new SlackApiError("invalid_arguments");
      const id = ids.next(SLACK_IDS.file);
      store.files.set(id, {
        id,
        name,
        title: name,
        size: length,
        user: bot(),
        created: Math.floor(clock() / 1000),
        bytes: undefined,
        conversation: undefined,
      });
      return { upload_url: `${context.apiUrl()}/upload/v1/${id}`, file_id: id };
    },

    "files.completeUploadExternal": (args) => {
      const listed = json(args, "files");
      if (!Array.isArray(listed) || listed.length === 0) throw new SlackApiError("invalid_arguments");
      const files = listed.map((entry: { id?: unknown; title?: unknown }) => {
        const file = typeof entry?.id === "string" ? store.files.get(entry.id) : undefined;
        // A file is there to share once its bytes arrived, and only once.
        if (!file || file.bytes === undefined || file.conversation !== undefined)
          throw new SlackApiError("file_not_found");
        if (typeof entry.title === "string" && entry.title !== "") file.title = entry.title;
        return file;
      });
      const channel = string(args, "channel_id");
      // Without a channel the files stay private to the app.
      if (channel !== undefined) {
        const conversation = joined(channel);
        const message = world.postAsApp(
          conversation,
          { text: string(args, "initial_comment") ?? "" },
          { threadTs: threadRoot(conversation, string(args, "thread_ts")), files },
        );
        for (const file of files) file.conversation = conversation.id;
        answeredIn(message);
      }
      return { files: files.map(({ id, title }) => ({ id, title })) };
    },

    "files.info": (args) => {
      const file = store.files.get(required(args, "file"));
      if (!file) throw new SlackApiError("file_not_found");
      return { file: fileObject(file) };
    },

    "reactions.add": (args) => {
      const conversation = joined(required(args, "channel"));
      world.react(
        conversation,
        messageIn(conversation, required(args, "timestamp")),
        bot(),
        required(args, "name"),
        "add",
      );
      return {};
    },

    "reactions.remove": (args) => {
      const conversation = joined(required(args, "channel"));
      world.react(
        conversation,
        messageIn(conversation, required(args, "timestamp")),
        bot(),
        required(args, "name"),
        "remove",
      );
      return {};
    },

    "reactions.get": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "timestamp"));
      return { type: "message", channel: conversation.id, message: messageOf(message) };
    },

    "conversations.info": (args) => ({ channel: conversationObject(joined(required(args, "channel")), true) }),

    "conversations.history": (args) => {
      const conversation = joined(required(args, "channel"));
      const { messages, has_more } = page(
        args,
        store
          .messagesIn(conversation.id)
          .filter(
            (message) => (message.threadTs === undefined || message.broadcast) && message.ephemeralFor === undefined,
          )
          .reverse(),
      );
      return { messages: messages.map(messageOf), has_more, pin_count: 0, response_metadata: { next_cursor: "" } };
    },

    "conversations.replies": (args) => {
      const conversation = joined(required(args, "channel"));
      // A split-view thread hangs on an anchor nobody sees: the thread exists, its root isn't shown.
      const root = store.findMessage(conversation.id, required(args, "ts"));
      if (!root || (root.ephemeralFor !== undefined && root.ephemeralFor !== NOBODY)) {
        throw new SlackApiError("thread_not_found");
      }
      const rootTs = root.threadTs ?? root.ts;
      const thread = store
        .messagesIn(conversation.id)
        .filter((message) => message.threadTs === rootTs && message.ephemeralFor === undefined);
      // The root is always first; the window and the limit apply to the replies under it.
      const { messages, has_more } = page(args, thread);
      const shown = root.ephemeralFor === undefined ? [root, ...messages] : messages;
      return { messages: shown.map(messageOf), has_more, response_metadata: { next_cursor: "" } };
    },

    "conversations.members": (args) => ({
      members: [...joined(required(args, "channel")).members],
      response_metadata: { next_cursor: "" },
    }),

    "conversations.join": (args) => {
      const conversation = store.conversations.find(required(args, "channel"));
      if (!conversation || conversation.kind === "private_channel") throw new SlackApiError("channel_not_found");
      if (conversation.kind !== "channel") throw new SlackApiError("method_not_supported_for_channel_type");
      if (conversation.isArchived) throw new SlackApiError("is_archived");
      if (conversation.members.has(bot()))
        return { channel: conversationObject(conversation), warning: "already_in_channel" };
      conversation.members.add(bot());
      world.emit(
        conversation,
        "member_joined_channel",
        membershipEvent("member_joined_channel", {
          user: bot(),
          conversation,
          team: store.team,
          eventTs: slackTs(ids),
        }),
      );
      return { channel: conversationObject(conversation) };
    },

    "conversations.open": (args) => {
      const existing = string(args, "channel");
      if (existing !== undefined) return { channel: { id: joined(existing).id }, no_op: true, already_open: true };
      const people = required(args, "users")
        .split(",")
        .map((id) => id.trim());
      const [first] = people;
      const owner = first === undefined ? undefined : store.users.owner(first);
      if (first === undefined || owner === undefined || people.some((id) => store.users.owner(id) !== owner)) {
        throw new SlackApiError("user_not_found");
      }
      return { channel: { id: world.openConversation(owner, first, [...people.slice(1), bot()]).id } };
    },

    "conversations.list": (args) => {
      const types = (string(args, "types") ?? "public_channel").split(",");
      const wanted = (conversation: SlackConversationRecord) =>
        ({ channel: "public_channel", private_channel: "private_channel", im: "im", mpim: "mpim" })[conversation.kind];
      const channels = store
        .allConversations()
        // Like Slack: every public channel, and only the private conversations the app is in.
        .filter(
          (conversation) =>
            types.includes(wanted(conversation)) &&
            (conversation.kind === "channel" || conversation.members.has(bot())),
        )
        .map((conversation) => conversationObject(conversation));
      return { channels, response_metadata: { next_cursor: "" } };
    },

    "users.info": (args) => {
      const id = required(args, "user");
      if (id === bot()) return { user: appUserObject() };
      const user = store.users.find(id);
      if (!user) throw new SlackApiError("user_not_found");
      return { user: userObject(user) };
    },

    "users.list": () => ({
      members: [appUserObject(), ...store.allUsers().map(userObject)],
      cache_ts: Math.floor(clock() / 1000),
      response_metadata: { next_cursor: "" },
    }),
  };

  const api = new Hono();

  api.all("/api/:method", async (c) => {
    const name = c.req.param("method");
    const startedAt = clock();
    const args: Args = { ...c.req.query() };
    if (c.req.method === "POST") {
      const type = c.req.header("content-type") ?? "";
      const body: unknown = type.includes("application/json")
        ? await c.req.json().catch(() => ({}))
        : await c.req.parseBody();
      if (typeof body === "object" && body !== null) Object.assign(args, body);
    }
    const token = bearerFrom(c.req.header("authorization")) ?? string(args, "token");
    delete args.token;

    let body: Record<string, unknown>;
    let status: 200 | 429 = 200;
    const headers: Record<string, string> = { "x-oauth-scopes": store.app.scopes.join(",") };
    const method = methods[name];
    try {
      if (token === undefined) throw new SlackApiError("not_authed");
      // Socket Mode connections are opened with the app-level token; everything else takes the bot token.
      const [expected, other] =
        name === "apps.connections.open" ? (["appToken", "botToken"] as const) : (["botToken", "appToken"] as const);
      if (!constantTimeEqual(token, context.secret(expected))) {
        // A real token of the wrong kind is told so; anything else is simply not a token.
        throw new SlackApiError(
          constantTimeEqual(token, context.secret(other)) ? "not_allowed_token_type" : "invalid_auth",
        );
      }
      if (!store.app.installed) throw new SlackApiError("account_inactive");
      if (!method) throw new SlackApiError("unknown_method", { req_method: name });

      // A fault a test injected: it applies to the next matching calls, whoever makes them.
      const fault = store.faults.find(
        (candidate) =>
          (candidate.operation === undefined || candidate.operation === name) &&
          (candidate.remaining === undefined || candidate.remaining > 0),
      );
      if (fault?.remaining !== undefined) fault.remaining -= 1;
      if (fault?.type === "latency") await delay(context.timers, fault.delayMs);
      if (fault?.type === "rate_limit") {
        // Slack answers 429 with Retry-After in seconds.
        status = 429;
        headers["retry-after"] = String(Math.max(1, Math.ceil(fault.retryAfterMs / 1000)));
        throw new SlackApiError("ratelimited");
      }
      if (fault?.type === "error") throw new SlackApiError(fault.error);

      const needed = SCOPES[name] ?? [];
      if (needed.length > 0 && !needed.some((scope) => store.app.scopes.includes(scope))) {
        throw new SlackApiError("missing_scope", { needed: needed.join(","), provided: store.app.scopes.join(",") });
      }
      body = { ok: true, ...method(args) };
    } catch (error) {
      // What the fake world refuses, it refuses with Slack's own code: that is the app's answer too.
      if (error instanceof SlackRefusal) body = { ok: false, error: error.code };
      else if (error instanceof SlackApiError) body = { ok: false, error: error.message, ...error.extra };
      else throw error;
    }

    // The call belongs to the session that owns what it was about: the conversation it named, else
    // the person, else the conversation a file was shared in. A call about nothing a session owns
    // (`auth.test`, `users.list`, a file not shared yet) is in no session's log.
    const file = store.files.get(string(args, "file") ?? "");
    const session = [
      string(args, "channel"),
      string(args, "channel_id"),
      typeof body.channel === "string" ? body.channel : undefined,
      string(args, "user"),
      ...(string(args, "users")?.split(",") ?? []),
      file?.conversation,
    ]
      .map((about) =>
        about === undefined ? undefined : (store.conversations.owner(about) ?? store.users.owner(about)),
      )
      .find((owner) => owner !== undefined);
    recordCall(
      context.events,
      "slack",
      [session],
      {
        operation: name,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        request: args,
        responseStatus: status,
        response: body,
        error: body.ok === false ? String(body.error) : undefined,
        durationMs: clock() - startedAt,
      },
      { unattributed: "drop" },
    );
    // A rate-limited agent backs off and retries: until the retry arrives, its session isn't quiet.
    if (session !== undefined) {
      if (status === 429) context.expectMore(session, name, Number(headers["retry-after"]) * 1000 + RETRY_GRACE_MS);
      else context.arrived(session, name);
    }
    return c.json(body, status, headers);
  });

  // A `response_url`: the app answers an interaction here. The URL is the credential, as with Slack's.
  api.post("/hooks/:kind/*", async (c) => {
    const key = c.req.path.split(`/hooks/${c.req.param("kind")}/`)[1] ?? "";
    const type = c.req.header("content-type") ?? "";
    // Slack takes JSON, or a form with the JSON in `payload`.
    const raw = type.includes("form") ? String((await c.req.parseBody()).payload ?? "") : await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("invalid_payload", 400);
    }
    if (typeof body !== "object" || body === null) return c.text("invalid_payload", 400);
    return world.respond(key, body as Record<string, unknown>) ? c.text("ok") : c.text("expired_url", 404);
  });

  // Where `files.getUploadURLExternal` sends the app with a file's bytes.
  api.post("/upload/v1/:file", async (c) => {
    // The URL is the credential, as with Slack's pre-signed upload URLs: clients post the bytes without a token.
    const file = store.files.get(c.req.param("file"));
    if (!file || file.bytes) return c.text("Not Found", 404);
    const type = c.req.header("content-type") ?? "";
    // Slack takes the raw bytes, or a multipart form with the file in it.
    const part = type.startsWith("multipart/form-data")
      ? [...(await c.req.formData()).values()].find((value) => typeof value !== "string")
      : undefined;
    const bytes = new Uint8Array(part ? await (part as Blob).arrayBuffer() : await c.req.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return c.text("Request Entity Too Large", 413);
    file.bytes = bytes;
    file.size = bytes.length;
    return c.text(`OK - ${bytes.length}`);
  });

  api.all("*", (c) => c.json({ ok: false, error: "unknown_method" }, 404));
  return api;
}
