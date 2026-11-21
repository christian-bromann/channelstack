import { Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import {
  membershipEvent,
  messageChangedEvent,
  messageDeletedEvent,
  messageObject,
  messageSubscription,
  reactionEvent,
} from "../payloads.ts";
import type { SlackConversationRecord, SlackMessageRecord, SlackUserRecord } from "../world.ts";
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
const MAX_TEXT_LENGTH = 40_000;
const MAX_STREAM_LENGTH = 12_000;
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
  "agents.sessions.setStatus": ["chat:write"],
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
export function createSlackApi(context: DriverContext, store: SlackStore, world: FakeSlackWorld): Hono {
  const { ids, clock } = context;
  const bot = () => store.app.botUserId;

  const userObject = (user: SlackUserRecord) => ({
    id: user.id,
    team_id: store.team.id,
    name: user.name.toLowerCase().replace(/\s+/g, "."),
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

  const conversationObject = (conversation: SlackConversationRecord) => {
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
    if (!message) throw new SlackApiError("message_not_found");
    return message;
  };

  const threadRoot = (conversation: SlackConversationRecord, ts: string | undefined): string | undefined => {
    if (ts === undefined || ts === "0") return undefined;
    const root = store.findMessage(conversation.id, ts);
    if (!root) throw new SlackApiError("thread_not_found");
    return root.threadTs ?? root.ts;
  };

  const text = (args: Args): { text: string; blocks: unknown[] } => {
    const blocks = json(args, "blocks");
    const value = string(args, "text") ?? string(args, "markdown_text") ?? "";
    if (value === "" && !(Array.isArray(blocks) && blocks.length > 0)) throw new SlackApiError("no_text");
    if (value.length > MAX_TEXT_LENGTH) throw new SlackApiError("msg_too_long");
    return { text: value, blocks: Array.isArray(blocks) ? blocks : [] };
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
    if (!stream || stream.state !== "open") throw new SlackApiError("message_not_in_streaming_state");
    if (piece === "") return;
    if (message.text.length + piece.length > MAX_STREAM_LENGTH) throw new SlackApiError("msg_too_long");
    stream.chunks.push(piece);
    message.text += piece;
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
      const previous = messageOf(message);
      Object.assign(message, text(args));
      const eventTs = ids.slackTs(conversation.id);
      message.edited = eventTs;
      world.emit(
        conversation,
        messageSubscription(conversation),
        messageChangedEvent(messageOf(message), previous, conversation, eventTs),
      );
      return { channel: conversation.id, ts: message.ts, text: message.text, message: messageOf(message) };
    },

    "chat.delete": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "ts"));
      if (message.user !== bot()) throw new SlackApiError("cant_delete_message");
      const previous = messageOf(message);
      store.removeMessage(conversation.id, message.ts);
      world.emit(
        conversation,
        messageSubscription(conversation),
        messageDeletedEvent(previous, conversation, ids.slackTs(conversation.id)),
      );
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
      appendToStream(message, streamed(args));
      const stream = message.stream;
      if (!stream) throw new SlackApiError("message_not_in_streaming_state");
      const blocks = json(args, "blocks");
      if (Array.isArray(blocks)) message.blocks = [...message.blocks, ...blocks];
      const metadata = json(args, "metadata");
      if (metadata !== undefined) message.metadata = metadata;
      stream.state = "completed";
      stream.endedAt = clock();
      const status = string(args, "session_status") ?? "active";
      if (!SESSION_STATUSES.some((known) => known === status)) throw new SlackApiError("invalid_arguments");
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

    "agents.sessions.setStatus": (args) => {
      const conversation = joined(required(args, "channel_id"));
      const status = required(args, "status");
      if (!SESSION_STATUSES.some((known) => known === status)) throw new SlackApiError("invalid_arguments");
      const threadTs = threadRoot(conversation, required(args, "thread_ts")) ?? required(args, "thread_ts");
      store.threadState(conversation.id, threadTs).sessionStatus = status as (typeof SESSION_STATUSES)[number];
      return { status, agent_status: status };
    },

    "reactions.add": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "timestamp"));
      const name = required(args, "name").replace(/^:|:$/g, "");
      const reaction = message.reactions.find((candidate) => candidate.name === name);
      if (reaction?.users.includes(bot())) throw new SlackApiError("already_reacted");
      if (reaction) reaction.users.push(bot());
      else message.reactions.push({ name, users: [bot()] });
      world.emit(
        conversation,
        "reaction_added",
        reactionEvent("add", { user: bot(), reaction: name, message, eventTs: ids.slackTs(conversation.id) }),
      );
      return {};
    },

    "reactions.remove": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "timestamp"));
      const name = required(args, "name").replace(/^:|:$/g, "");
      const reaction = message.reactions.find((candidate) => candidate.name === name);
      if (!reaction?.users.includes(bot())) throw new SlackApiError("no_reaction");
      reaction.users.splice(reaction.users.indexOf(bot()), 1);
      if (reaction.users.length === 0) message.reactions.splice(message.reactions.indexOf(reaction), 1);
      world.emit(
        conversation,
        "reaction_removed",
        reactionEvent("remove", { user: bot(), reaction: name, message, eventTs: ids.slackTs(conversation.id) }),
      );
      return {};
    },

    "reactions.get": (args) => {
      const conversation = joined(required(args, "channel"));
      const message = messageIn(conversation, required(args, "timestamp"));
      return { type: "message", channel: conversation.id, message: messageOf(message) };
    },

    "conversations.info": (args) => ({ channel: conversationObject(joined(required(args, "channel"))) }),

    "conversations.history": (args) => {
      const conversation = joined(required(args, "channel"));
      const messages = store
        .messagesIn(conversation.id)
        .filter((message) => message.threadTs === undefined && message.ephemeralFor === undefined)
        .map(messageOf)
        .reverse();
      return { messages, has_more: false, pin_count: 0, response_metadata: { next_cursor: "" } };
    },

    "conversations.replies": (args) => {
      const conversation = joined(required(args, "channel"));
      const root = messageIn(conversation, required(args, "ts"));
      const rootTs = root.threadTs ?? root.ts;
      const messages = store
        .messagesIn(conversation.id)
        .filter(
          (message) => (message.ts === rootTs || message.threadTs === rootTs) && message.ephemeralFor === undefined,
        )
        .map(messageOf);
      return { messages, has_more: false, response_metadata: { next_cursor: "" } };
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
          eventTs: ids.slackTs(conversation.id),
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
        .map(conversationObject);
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
      if (!constantTimeEqual(token, context.secret("botToken"))) throw new SlackApiError("invalid_auth");
      if (!store.app.installed) throw new SlackApiError("account_inactive");
      if (!method) throw new SlackApiError("unknown_method", { req_method: name });

      // A fault a test injected: it applies to the next matching calls, whoever makes them.
      const fault = store.faults.find(
        (candidate) =>
          (candidate.operation === undefined || candidate.operation === name) &&
          (candidate.remaining === undefined || candidate.remaining > 0),
      );
      if (fault?.remaining !== undefined) fault.remaining -= 1;
      if (fault?.type === "latency") await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
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
      if (!(error instanceof SlackApiError)) throw error;
      body = { ok: false, error: error.message, ...error.extra };
    }

    // The call belongs to the session that owns the conversation it was about, if it named one.
    const about =
      string(args, "channel") ??
      string(args, "channel_id") ??
      (typeof body.channel === "string" ? body.channel : undefined);
    const session = about === undefined ? undefined : (store.conversations.owner(about) ?? store.users.owner(about));
    if (session !== undefined) {
      context.events.append(session, "slack", "api_call", {
        operation: name,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        request: args,
        responseStatus: status,
        response: body,
        ...(body.ok === false ? { error: body.error } : {}),
        durationMs: clock() - startedAt,
      });
    }
    // A rate-limited agent backs off and retries: until the retry arrives, its session isn't quiet.
    if (session !== undefined) {
      if (status === 429) context.expectMore(session, name, Number(headers["retry-after"]) * 1000 + RETRY_GRACE_MS);
      else context.arrived(session, name);
    }
    return c.json(body, status, headers);
  });

  api.all("*", (c) => c.json({ ok: false, error: "unknown_method" }, 404));
  return api;
}
