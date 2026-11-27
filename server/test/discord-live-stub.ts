interface StubMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; global_name: string | null; bot?: boolean };
  content: string;
  type: number;
  timestamp: string;
  message_reference?: { message_id: string };
  components?: unknown[];
  embeds?: unknown[];
  edited_timestamp?: string;
  reactions?: Array<{ emoji: { name: string }; count: number; me: boolean; users: string[] }>;
  thread?: { id: string };
}

interface StubChannel {
  id: string;
  type: number;
  name: string;
  guild_id?: string;
  parent_id?: string;
  owner_id?: string;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
  messages: StubMessage[];
}

/** A bot token in Discord's form for a bot's id: its id in base64, a timestamp and an HMAC. */
const tokenOf = (id: string, secret: string) =>
  `${Buffer.from(id).toString("base64").replace(/=+$/, "")}.GaBcDe.${secret.padEnd(38, "x").slice(0, 38)}`;

/**
 * Real Discord in a unit test of live mode: a guild in memory with the agent's bot in it, answering
 * the REST calls the live backend makes, as the agent's bot and as each person's bot (a second
 * application's, decision 0026), by the token each call carries. `agentReplies` plays the agent.
 */
export function discordStub(options: { guild?: string; botName?: string } = {}) {
  const guild = options.guild ?? "1100000000000000001";
  const bot = {
    id: "1100000000000000002",
    // What the agent's bot is called in the guild: a real one has its own name, not the tests' `my-agent`.
    username: options.botName ?? "my-agent",
    token: "MTEwMDAwMDAwMDAwMDAwMDAwMg.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB",
  };
  /** Each person's bot: in the guild unless `outside`, an administrator if `admin`; `human` is a token that isn't a bot's. */
  const people = new Map<
    string,
    { id: string; username: string; token: string; admin: boolean; outside: boolean; human: boolean }
  >();
  const channels = new Map<string, StubChannel>();
  /** Every call, with whose bot made it: `app`, or the person's username. */
  const calls: Array<{ method: string; path: string; body?: unknown; by: string }> = [];
  let next = 1_200_000_000_000_000_000n;
  const snowflake = () => {
    next += 1n;
    return String(next);
  };
  let replying: ((message: StubMessage) => string | undefined) | undefined;
  const post = (
    channel: StubChannel,
    author: StubMessage["author"],
    content: string,
    reference?: string,
    embeds?: unknown[],
  ) => {
    const message: StubMessage = {
      id: snowflake(),
      channel_id: channel.id,
      author,
      content,
      type: reference ? 19 : 0,
      timestamp: new Date().toISOString(),
      ...(reference ? { message_reference: { message_id: reference } } : {}),
      ...(embeds ? { embeds } : {}),
    };
    channel.messages.push(message);
    // The agent hears the person from Discord itself, and answers as the bot.
    if (author.id !== bot.id && replying) {
      const answer = replying(message);
      if (answer !== undefined)
        post(channel, { id: bot.id, username: bot.username, global_name: null, bot: true }, answer, message.id);
    }
    return message;
  };

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refuse = (status: number, code: number, message: string) => json(status, { message, code });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const person = [...people.values()].find((each) => authorization === `Bot ${each.token}`);
    if (authorization !== `Bot ${bot.token}` && !person) return refuse(401, 0, "401: Unauthorized");
    calls.push({ method, path, ...(body === undefined ? {} : { body }), by: person?.username ?? "app" });
    const me = person ?? { ...bot, outside: false, human: false };
    const author = { id: me.id, username: me.username, global_name: null, bot: true };
    if (path === "/users/@me") return json(200, { id: me.id, username: me.username, bot: !me.human });
    if (path === "/oauth2/applications/@me") return json(200, { id: me.id, name: me.username, flags: 1 << 19 });
    if (path === "/users/@me/guilds") return json(200, me.outside ? [] : [{ id: guild, name: "Sandbox" }]);
    if (path === `/guilds/${guild}/roles`)
      return json(200, [
        { id: guild, permissions: "0" },
        { id: "1100000000000000099", permissions: "8" },
      ]);
    let match = new RegExp(`^/guilds/${guild}/members/(\\d+)$`).exec(path);
    if (match) {
      const member = [...people.values()].find((each) => each.id === match?.[1] && !each.outside);
      return member
        ? json(200, {
            user: { id: member.id, username: member.username, bot: true },
            roles: member.admin ? ["1100000000000000099"] : [],
          })
        : refuse(404, 10013, "Unknown User");
    }
    if (path === `/guilds/${guild}/threads/active`) {
      const threads = [...channels.values()].filter((channel) => channel.type === 11);
      return json(200, { threads: threads.map(({ messages: _messages, ...wire }) => wire) });
    }
    if (path === `/guilds/${guild}/channels` && method === "POST") {
      const channel: StubChannel = {
        id: snowflake(),
        type: 0,
        guild_id: guild,
        name: body.name,
        permission_overwrites: body.permission_overwrites,
        messages: [],
      };
      channels.set(channel.id, channel);
      const { messages: _messages, ...wire } = channel;
      return json(201, wire);
    }
    if (path === `/guilds/${guild}/channels`) {
      return json(
        200,
        [...channels.values()].filter((channel) => channel.type === 0).map(({ messages: _messages, ...wire }) => wire),
      );
    }
    if (path === "/users/@me/channels" && method === "POST") {
      if ([...people.values()].some((each) => each.id === body.recipient_id))
        return refuse(403, 50007, "Cannot send messages to this user");
      const existing = [...channels.values()].find(
        (channel) => channel.type === 1 && channel.name === body.recipient_id,
      );
      const channel = existing ?? { id: snowflake(), type: 1, name: body.recipient_id, messages: [] };
      channels.set(channel.id, channel);
      return json(200, { id: channel.id, type: 1, recipients: [{ id: body.recipient_id }] });
    }
    match = /^\/channels\/(\d+)(\/.*)?$/.exec(path);
    const channel = match ? channels.get(match[1] as string) : undefined;
    if (match && !channel) return refuse(404, 10003, "Unknown Channel");
    if (channel) {
      const rest = match?.[2] ?? "";
      if (rest === "" && method === "DELETE") {
        channels.delete(channel.id);
        return json(200, { id: channel.id });
      }
      const { messages: _messages, ...wire } = channel;
      if (rest === "") return json(200, wire);
      if (rest === "/messages" && method === "POST") {
        if (!sees(channel, me.id)) return refuse(403, 50001, "Missing Access");
        return json(200, post(channel, author, body.content ?? "", body.message_reference?.message_id, body.embeds));
      }
      if (rest === "/messages")
        return json(200, [...channel.messages].reverse().slice(0, Number(url.searchParams.get("limit") ?? 50)));
      if (rest === "/threads" && method === "POST") return json(201, thread(channel, me.id, body.name));
      const one = /^\/messages\/(\d+)(\/.*)?$/.exec(rest);
      if (one) {
        const message = channel.messages.find((each) => each.id === one[1]);
        if (!message) return refuse(404, 10008, "Unknown Message");
        const sub = one[2] ?? "";
        if (sub === "" && method === "PATCH") {
          if (message.author.id !== me.id) return refuse(403, 50005, "Cannot edit a message authored by another user");
          Object.assign(message, {
            ...(body.content === undefined ? {} : { content: body.content }),
            ...(body.embeds === undefined ? {} : { embeds: body.embeds }),
            edited_timestamp: new Date().toISOString(),
          });
          return json(200, message);
        }
        if (sub === "" && method === "DELETE") {
          if (message.author.id !== me.id && !person?.admin) return refuse(403, 50013, "Missing Permissions");
          channel.messages = channel.messages.filter((each) => each !== message);
          return json(204);
        }
        if (sub === "") return json(200, message);
        if (sub === "/threads" && method === "POST") {
          const started = thread(channel, me.id, body.name);
          message.thread = { id: started.id };
          return json(201, started);
        }
        const reaction = /^\/reactions\/([^/]+)(\/@me)?$/.exec(sub);
        if (reaction) {
          const name = decodeURIComponent(reaction[1] as string);
          message.reactions ??= [];
          let found = message.reactions.find((each) => each.emoji.name === name);
          if (method === "PUT") {
            if (!found) {
              found = { emoji: { name }, count: 0, me: false, users: [] };
              message.reactions.push(found);
            }
            if (!found.users.includes(me.id)) found.users.push(me.id);
            found.count = found.users.length;
            return json(204);
          }
          if (method === "DELETE") {
            if (found) found.users = found.users.filter((each) => each !== me.id);
            message.reactions = message.reactions.filter((each) => each.users.length > 0);
            return json(204);
          }
          return json(
            200,
            (found?.users ?? []).map((id) => ({ id })),
          );
        }
      }
      const permission = /^\/permissions\/(\d+)$/.exec(rest);
      if (permission && method === "PUT") {
        channel.permission_overwrites = [
          ...(channel.permission_overwrites ?? []).filter((each) => each.id !== permission[1]),
          { id: permission[1] as string, type: body.type, allow: body.allow, deny: body.deny },
        ];
        return json(204);
      }
    }
    return refuse(404, 0, "404: Not Found");
  }) as typeof globalThis.fetch;

  /** Whether a bot sees a channel: by an overwrite of its own, or as one of its thread's parent's. */
  const sees = (channel: StubChannel, id: string): boolean => {
    if (channel.parent_id) {
      const parent = channels.get(channel.parent_id);
      return parent !== undefined && sees(parent, id);
    }
    return channel.type !== 0 || (channel.permission_overwrites ?? []).some((each) => each.id === id);
  };
  const thread = (parent: StubChannel, owner: string, name: string) => {
    const started: StubChannel = {
      id: snowflake(),
      type: 11,
      name,
      guild_id: guild,
      parent_id: parent.id,
      owner_id: owner,
      messages: [],
    };
    channels.set(started.id, started);
    const { messages: _messages, ...wire } = started;
    return wire;
  };

  return {
    guild,
    bot,
    calls,
    channels,
    fetch,
    apiBase: "https://discord.stub/api/v10",
    /** A person's bot, a second application's, with its token: in the guild unless `outside`. */
    person(username: string, options: { admin?: boolean; outside?: boolean; human?: boolean } = {}) {
      const id = snowflake();
      const person = {
        id,
        username,
        token: tokenOf(id, `${username}secret`),
        admin: options.admin === true,
        outside: options.outside === true,
        human: options.human === true,
      };
      people.set(username, person);
      return person;
    },
    /** The agent: what it answers each person's message with, or nothing. */
    agentReplies(answer: (message: StubMessage) => string | undefined) {
      replying = answer;
    },
  };
}

export type DiscordStub = ReturnType<typeof discordStub>;
