import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Slack's Web API in unit tests of live mode: a workspace in memory that
 * answers the methods the live backend calls, in Slack's shapes, and records every call with
 * whose token made it. Tests hand its `fetch` and `apiBase` to the app (`harness(…, { live })`).
 */
export interface SlackStub {
  readonly apiBase: string;
  fetch: typeof fetch;
  readonly team: string;
  /** The app's bot token and bot user. */
  readonly bot: { token: string; userId: string; botId: string };
  /** Add a person; their token is what the test hands to `createUser`. */
  /** Add a person; their token is what the test hands to `createUser`. */
  person(handle: string, options?: { team?: string }): { token: string; userId: string };
  /**
   * A person types a message in Slack's client: it carries no app's bot, unlike one posted through
   * the API with their token (decision 0015). The browser actor will do this live; tests stand in.
   */
  typed(userId: string, channel: string, text: string, threadTs?: string): string;
  /** Every call so far: the method, and the handle (or `bot`) whose token made it. */
  readonly calls: Array<{ method: string; as: string; params: Record<string, unknown> }>;
  /** The app answers in a conversation, as the real agent would (Slack delivered the event to it, not channelstack). */
  botSays(channel: string, text: string, threadTs?: string): string;
  channel(id: string): StubChannel | undefined;
  /** Channels by name, archived ones included. */
  channels(): StubChannel[];
}

interface StubMessage {
  ts: string;
  user: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; users: string[] }>;
  edited?: { ts: string };
}

interface StubChannel {
  id: string;
  name: string | undefined;
  isPrivate: boolean;
  isIm: boolean;
  created: number;
  creator: string;
  members: Set<string>;
  archived: boolean;
  messages: StubMessage[];
}

export function slackStub(options: { team?: string } = {}): SlackStub {
  const team = options.team ?? "T0STUB0001";
  /** The bot of the app that issued the people's tokens: what Slack marks their API posts with. */
  const PEOPLE_APP_BOT = "B0STUBPEOPLE";
  const bot = { token: `xoxb-${randomString(24, "abcdef0123456789")}`, userId: "U0STUBBOT1", botId: "B0STUBBOT1" };
  const tokens = new Map<string, { handle: string; userId: string; team: string; isBot: boolean }>([
    [bot.token, { handle: "bot", userId: bot.userId, team, isBot: true }],
  ]);
  const users = new Map<string, { id: string; name: string }>([[bot.userId, { id: bot.userId, name: "robin" }]]);
  const channels = new Map<string, StubChannel>();
  const calls: SlackStub["calls"] = [];
  let clock = 1_800_000_000;
  let counter = 0;
  const ts = () => `${++clock}.${String(++counter).padStart(6, "0")}`;
  const ok = (body: Record<string, unknown> = {}) => Response.json({ ok: true, ...body });
  const refuse = (error: string) => Response.json({ ok: false, error });

  /** `botId`: the app whose bot a message carries (any API post), or none (typed in the client). */
  const post = (channel: StubChannel, user: string, text: string, threadTs?: string, botId?: string): StubMessage => {
    const message: StubMessage = {
      ts: ts(),
      user,
      text,
      ...(botId ? { bot_id: botId } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    };
    channel.messages.push(message);
    if (threadTs) {
      const root = channel.messages.find((candidate) => candidate.ts === threadTs);
      if (root) {
        root.thread_ts = threadTs;
        root.reply_count = (root.reply_count ?? 0) + 1;
      }
    }
    return message;
  };
  const top = (channel: StubChannel) =>
    channel.messages.filter((message) => message.thread_ts === undefined || message.thread_ts === message.ts);

  const handle = (method: string, who: { handle: string; userId: string; team: string; isBot: boolean }, p: any) => {
    const channel = typeof p.channel === "string" ? channels.get(p.channel) : undefined;
    const member = () => channel?.members.has(who.userId) === true;
    switch (method) {
      case "auth.test":
        return ok({
          team_id: who.team,
          team: "Stub",
          url: "https://stub.slack.com/",
          user_id: who.userId,
          ...(who.isBot ? { bot_id: bot.botId } : {}),
        });
      case "users.info": {
        const user = users.get(p.user);
        return user
          ? ok({ user: { id: user.id, name: user.name, profile: { display_name: user.name } } })
          : refuse("user_not_found");
      }
      case "conversations.create": {
        if (who.isBot) return refuse("missing_scope");
        if ([...channels.values()].some((existing) => existing.name === p.name)) return refuse("name_taken");
        const created: StubChannel = {
          id: `C0${randomString(9, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`,
          name: p.name,
          isPrivate: p.is_private === true,
          isIm: false,
          created: clock,
          creator: who.userId,
          members: new Set([who.userId]),
          archived: false,
          messages: [],
        };
        channels.set(created.id, created);
        return ok({ channel: { id: created.id, name: created.name, created: created.created } });
      }
      case "conversations.invite":
        if (!member()) return refuse("not_in_channel");
        for (const id of String(p.users).split(",")) channel?.members.add(id);
        return ok({ channel: { id: channel?.id } });
      case "conversations.kick":
        if (!member()) return refuse("not_in_channel");
        channel?.members.delete(p.user);
        return ok();
      case "conversations.setTopic":
      case "conversations.setPurpose":
        return member() ? ok() : refuse("not_in_channel");
      case "conversations.archive":
        if (!channel) return refuse("channel_not_found");
        if (channel.archived) return refuse("already_archived");
        if (!member()) return refuse("not_in_channel");
        channel.archived = true;
        return ok();
      case "conversations.open": {
        const members = new Set([who.userId, ...String(p.users).split(",")]);
        const existing = [...channels.values()].find(
          (candidate) =>
            candidate.isIm &&
            [...members].every((id) => candidate.members.has(id)) &&
            candidate.members.size === members.size,
        );
        const dm: StubChannel = existing ?? {
          id: `D0${randomString(9, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`,
          name: undefined,
          isPrivate: true,
          isIm: true,
          created: clock,
          creator: who.userId,
          members,
          archived: false,
          messages: [],
        };
        channels.set(dm.id, dm);
        return ok({ channel: { id: dm.id, created: dm.created } });
      }
      case "conversations.history": {
        if (!channel) return refuse("channel_not_found");
        if (!member()) return refuse("not_in_channel");
        const oldest = typeof p.oldest === "string" ? p.oldest : "0";
        return ok({
          messages: top(channel)
            .filter((message) => message.ts >= oldest)
            .reverse(),
          has_more: false,
        });
      }
      case "conversations.replies": {
        if (!channel) return refuse("channel_not_found");
        if (!member()) return refuse("not_in_channel");
        const asked = channel.messages.find((message) => message.ts === p.ts);
        if (!asked) return refuse("thread_not_found");
        const root = asked.thread_ts ?? asked.ts;
        return ok({
          messages: channel.messages.filter((message) => message.ts === root || message.thread_ts === root),
        });
      }
      case "conversations.list":
        return ok({
          channels: [...channels.values()]
            .filter((candidate) => !candidate.isIm && !(p.exclude_archived && candidate.archived))
            .filter((candidate) => !candidate.isPrivate || candidate.members.has(who.userId))
            .map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              created: candidate.created,
              is_archived: candidate.archived,
              is_member: candidate.members.has(who.userId),
            })),
        });
      case "chat.postMessage": {
        if (!channel) return refuse("channel_not_found");
        if (channel.archived) return refuse("is_archived");
        if (!member()) return refuse("not_in_channel");
        if (!p.text && !p.blocks) return refuse("no_text");
        // Through the API a message carries the posting app's bot, a person's token included.
        const message = post(channel, who.userId, p.text ?? "", p.thread_ts, who.isBot ? bot.botId : PEOPLE_APP_BOT);
        return ok({ channel: channel.id, ts: message.ts, message });
      }
      case "chat.update": {
        const message = channel?.messages.find((candidate) => candidate.ts === p.ts);
        if (!message) return refuse("message_not_found");
        if (message.user !== who.userId) return refuse("cant_update_message");
        message.text = p.text;
        message.edited = { ts: ts() };
        return ok({ channel: channel?.id, ts: message.ts });
      }
      case "chat.delete": {
        const message = channel?.messages.find((candidate) => candidate.ts === p.ts);
        if (!channel || !message) return refuse("message_not_found");
        if (message.user !== who.userId) return refuse("cant_delete_message");
        channel.messages = channel.messages.filter((candidate) => candidate !== message);
        return ok({ channel: channel.id, ts: message.ts });
      }
      case "reactions.add":
      case "reactions.remove": {
        const message = channel?.messages.find((candidate) => candidate.ts === p.timestamp);
        if (!message) return refuse("message_not_found");
        message.reactions ??= [];
        let reaction = message.reactions.find((candidate) => candidate.name === p.name);
        if (method === "reactions.add") {
          if (reaction?.users.includes(who.userId)) return refuse("already_reacted");
          if (!reaction) {
            reaction = { name: p.name, users: [] };
            message.reactions.push(reaction);
          }
          reaction.users.push(who.userId);
        } else {
          if (!reaction?.users.includes(who.userId)) return refuse("no_reaction");
          reaction.users = reaction.users.filter((id) => id !== who.userId);
          message.reactions = message.reactions.filter((candidate) => candidate.users.length > 0);
        }
        return ok();
      }
      default:
        return refuse("unknown_method");
    }
  };

  const apiBase = "https://slack.stub/api";
  const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!url.href.startsWith(apiBase)) throw new Error(`The live backend called ${url.origin}, not the stub`);
    const method = url.pathname.split("/").at(-1) ?? "";
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    // Form-encoded, as real Slack's read methods require: a JSON body would come through empty.
    const type = new Headers(init?.headers).get("content-type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return refuse("invalid_form_data");
    const params: Record<string, unknown> = {};
    for (const [name, value] of new URLSearchParams(String(init?.body ?? ""))) {
      params[name] = value === "true" ? true : value === "false" ? false : value;
    }
    const who = tokens.get(token);
    calls.push({ method, as: who?.handle ?? "nobody", params });
    if (!who) return refuse("invalid_auth");
    return handle(method, who, params);
  }) as typeof fetch;

  return {
    apiBase,
    fetch: stubFetch,
    team,
    bot,
    calls,
    person(handleName, personOptions = {}) {
      const userId = `U0${randomString(9, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;
      const token = `xoxp-${randomString(24, "abcdef0123456789")}`;
      tokens.set(token, {
        handle: handleName,
        userId,
        team: personOptions.team ?? team,
        isBot: false,
      });
      users.set(userId, { id: userId, name: handleName });
      return { token, userId };
    },
    botSays(channelId, text, threadTs) {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`No channel ${channelId}`);
      return post(channel, bot.userId, text, threadTs, bot.botId).ts;
    },
    typed(userId, channelId, text, threadTs) {
      const channel = channels.get(channelId);
      if (!channel) throw new Error(`No channel ${channelId}`);
      return post(channel, userId, text, threadTs).ts;
    },
    channel: (id) => channels.get(id),
    channels: () => [...channels.values()],
  };
}
