import { createHash } from "node:crypto";

import { type Context, Hono } from "hono";

import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import {
  applicationFlags,
  applicationObject,
  guildObject,
  JOINED_AT,
  memberObject,
  MESSAGE_FLAGS,
  userObject,
} from "../payloads.ts";
import { has } from "../permissions.ts";
import { publicKeyOf } from "../signing.ts";
import { type DiscordChannelRecord, DiscordRefusal } from "../world.ts";
import type { Gateway } from "./gateway.ts";
import type { FakeDiscordWorld } from "./world.ts";

/** A route's rate limit: so many calls per window, per its major parameter (the channel). */
interface Bucket {
  readonly limit: number;
  readonly windowMs: number;
}

/** Discord's limits the fake keeps: messages per channel, reactions, and the rest of a route. */
const MESSAGES: Bucket = { limit: 5, windowMs: 5000 };
const REACTIONS: Bucket = { limit: 1, windowMs: 250 };
const DEFAULT: Bucket = { limit: 50, windowMs: 1000 };
/** How long the quiet detector waits past a 429's `retry_after` for the bot to call again. */
const RETRY_GRACE_MS = 2000;

/** A call over a route's limit: Discord's 429, with the headers that say when to call again. */
class RateLimited extends Error {
  readonly retryAfterMs: number;
  readonly headers: Record<string, string>;

  constructor(retryAfterMs: number, headers: Record<string, string>) {
    super("You are being rate limited.");
    this.retryAfterMs = retryAfterMs;
    this.headers = headers;
  }
}

/** An error as Discord answers it: `{ message, code }`, and `errors` for a form it refuses. */
const errorAnswer = (status: number, code: number, message: string, errors?: Record<string, unknown>): RestAnswer => ({
  body: { message, code, ...(errors ? { errors } : {}) },
  sessions: [],
  status,
});

/**
 * The calls that need no bot token: where the Gateway is (`GET /gateway`, unlike `/gateway/bot`),
 * and an interaction's callback and followups, which carry their own token.
 */
const NO_BOT_TOKEN = /^(?:GET \/gateway$|POST \/interactions\/|[A-Z]+ \/webhooks\/)/;

export function createDiscordApi(context: DriverContext, world: FakeDiscordWorld, gateway: Gateway): Hono {
  const { clock } = context;
  const { store } = world;
  /** Each bucket's window, by route and channel: when it started and how many calls it had. */
  const windows = new Map<string, { startedAt: number; used: number }>();

  const { endpoint, finish } = restApi(context, {
    driver: "discord",
    authorize(c, operation) {
      if (NO_BOT_TOKEN.test(operation)) return undefined;
      const header = c.req.header("authorization") ?? "";
      const token = /^Bot (.+)$/.exec(header)?.[1] ?? "";
      if (token === "" || !constantTimeEqual(token, context.secret("botToken"))) {
        return errorAnswer(401, 0, "401: Unauthorized");
      }
      return undefined;
    },
    refusal: (error) => refusalOf(error),
    invalidJson: () => errorAnswer(400, 50109, "The request body contains invalid JSON."),
    notFound: () => errorAnswer(404, 0, "404: Not Found"),
  });

  function refusalOf(error: unknown): RestAnswer | undefined {
    if (error instanceof DiscordRefusal) {
      return errorAnswer(error.httpStatus, error.discordCode, error.message, error.errors);
    }
    if (error instanceof RateLimited) {
      return {
        // Discord's description holds a 429 to its error shape too: `code` 0, as its other generic refusals.
        body: { message: error.message, code: 0, retry_after: error.retryAfterMs / 1000, global: false },
        sessions: [],
        status: 429,
        headers: error.headers,
      };
    }
    return undefined;
  }

  const sessionOf = (channel: DiscordChannelRecord | undefined) => (channel ? [world.sessionOf(channel.id)] : []);

  /**
   * Count a call against its route's bucket, or refuse it with a 429: a test's `rate_limit`
   * fault, or the route's own limit. Returns the headers every answer of the route carries.
   */
  const limit = (route: string, major: string, bucket: Bucket): Record<string, string> => {
    const fault = store.faults.find(
      (candidate) => candidate.type === "rate_limit" && (candidate.route === undefined || candidate.route === route),
    );
    const hash = createHash("sha1").update(route).digest("hex").slice(0, 32);
    if (fault) {
      if (fault.remaining !== undefined) {
        fault.remaining -= 1;
        if (fault.remaining <= 0) store.faults.splice(store.faults.indexOf(fault), 1);
      }
      const after = fault.retryAfterMs / 1000;
      context.expectMore(fault.session, route, fault.retryAfterMs + RETRY_GRACE_MS);
      throw new RateLimited(fault.retryAfterMs, {
        "retry-after": String(Math.ceil(after)),
        "x-ratelimit-limit": String(bucket.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": ((clock() + fault.retryAfterMs) / 1000).toFixed(3),
        "x-ratelimit-reset-after": after.toFixed(3),
        "x-ratelimit-bucket": hash,
        "x-ratelimit-scope": "user",
      });
    }
    const key = `${route} ${major}`;
    const now = clock();
    let window = windows.get(key);
    if (!window || now - window.startedAt >= bucket.windowMs) {
      window = { startedAt: now, used: 0 };
      windows.set(key, window);
    }
    const resetAt = window.startedAt + bucket.windowMs;
    const headers = {
      "x-ratelimit-limit": String(bucket.limit),
      "x-ratelimit-remaining": String(Math.max(0, bucket.limit - window.used - 1)),
      "x-ratelimit-reset": (resetAt / 1000).toFixed(3),
      "x-ratelimit-reset-after": ((resetAt - now) / 1000).toFixed(3),
      "x-ratelimit-bucket": hash,
    };
    if (window.used >= bucket.limit) {
      const after = (resetAt - now) / 1000;
      throw new RateLimited(resetAt - now, {
        ...headers,
        "x-ratelimit-remaining": "0",
        "retry-after": String(Math.ceil(after)),
        "x-ratelimit-scope": "user",
      });
    }
    window.used += 1;
    return headers;
  };

  /** A route with its rate limit: the handler's answer, with the bucket's headers. */
  const limited = (
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    operation: string,
    bucket: Bucket,
    handle: (c: Context, body: Record<string, unknown>) => RestAnswer,
  ) =>
    endpoint(method, path, operation, (c, body) => {
      const major = c.req.param("channel") ?? c.req.param("guild") ?? "";
      // A refusal is the channel's session's call too: a test sees the bot's 50001s and 429s.
      const sessions = c.req.param("channel") === undefined ? [] : [world.sessionOf(major)];
      try {
        const headers = limit(operation, major, bucket);
        const answer = handle(c, body);
        for (const session of answer.sessions) if (session !== undefined) context.arrived(session, operation);
        return { ...answer, headers: { ...headers, ...answer.headers } };
      } catch (error) {
        const refused = refusalOf(error);
        if (!refused) throw error;
        return { ...refused, sessions };
      }
    });

  /** A channel the bot asks about: refused when it doesn't exist (10003) or the bot can't see it (50001). */
  const channelOf = (c: Context): DiscordChannelRecord => {
    const channel = store.channels.find(c.req.param("channel") ?? "");
    if (!channel) throw new DiscordRefusal(10003);
    world.requireBot(channel);
    return channel;
  };

  const messageIn = (channel: DiscordChannelRecord, id: string) => {
    const message = store.findMessage(channel.id, id);
    if (!message || message.ephemeralFor !== undefined || message.system) throw new DiscordRefusal(10008);
    return message;
  };

  const guildOf = (c: Context) => {
    if (c.req.param("guild") !== store.guild.id) throw new DiscordRefusal(50001);
    return store.guild;
  };

  const roles = () => world.guildRoles();

  const botUser = () => ({
    ...userObject({ kind: "app", app: store.app }),
    verified: true,
    mfa_enabled: false,
    email: null,
    locale: "en-US",
    premium_type: 0,
  });

  const application = () =>
    applicationObject(store.app, {
      publicKey: publicKeyOf(context.secret("interactionsKey")),
      flags: applicationFlags(store.app.privilegedIntents),
      interactionsUrl: context.webhookUrl,
      guilds: 1,
    });

  // --- The Gateway, the bot, the application ----------------------------------------------------

  const gatewayInfo = () => ({ url: gateway.url() });
  endpoint("get", "/gateway", "GET /gateway", () => ({ body: gatewayInfo(), sessions: [] }));
  endpoint("get", "/gateway/bot", "GET /gateway/bot", () => ({
    body: {
      ...gatewayInfo(),
      shards: 1,
      session_start_limit: { total: 1000, remaining: 999, reset_after: 86_400_000, max_concurrency: 1 },
    },
    sessions: [],
  }));
  endpoint("get", "/users/@me", "GET /users/@me", () => ({ body: botUser(), sessions: [] }));
  for (const path of ["/applications/@me", "/oauth2/applications/@me"]) {
    endpoint("get", path, `GET ${path}`, () => ({ body: application(), sessions: [] }));
  }
  endpoint("get", "/users/:user", "GET /users/{user.id}", (c) => {
    const author = world.authorOf(c.req.param("user") ?? "");
    if (!author) throw new DiscordRefusal(10013);
    return {
      body: userObject(author),
      sessions: author.kind === "user" ? [store.users.owner(author.user.id)] : [],
    };
  });
  endpoint("post", "/users/@me/channels", "POST /users/@me/channels", (_c, body) => {
    const recipient = typeof body.recipient_id === "string" ? store.users.find(body.recipient_id) : undefined;
    if (!recipient) {
      throw new DiscordRefusal(50035, {
        errors: { recipient_id: { _errors: [{ code: "NUMBER_TYPE_COERCE", message: "Value is not snowflake." }] } },
      });
    }
    if (recipient.bot) throw new DiscordRefusal(50007);
    const channel = world.dmWith(recipient.id);
    return { body: world.channelWire(channel), sessions: sessionOf(channel) };
  });

  // --- Channels and messages ------------------------------------------------------------------

  limited("get", "/channels/:channel", "GET /channels/{channel.id}", DEFAULT, (c) => {
    const channel = channelOf(c);
    return { body: world.channelWire(channel), sessions: sessionOf(channel) };
  });

  limited("get", "/channels/:channel/messages", "GET /channels/{channel.id}/messages", DEFAULT, (c) => {
    const channel = channelOf(c);
    world.requireBot(channel, "READ_MESSAGE_HISTORY");
    // What Discord refuses here: a `limit` outside 1 to 100, a `before` or `after` that isn't a snowflake.
    const field = (name: string, code: string, message: string) =>
      new DiscordRefusal(50035, { errors: { [name]: { _errors: [{ code, message }] } } });
    const limit = c.req.query("limit") ?? "50";
    const wanted = Number(limit);
    if (!/^-?\d+$/.test(limit)) throw field("limit", "NUMBER_TYPE_COERCE", `Value "${limit}" is not int.`);
    if (wanted < 1) throw field("limit", "NUMBER_TYPE_MIN", "int value should be greater than or equal to 1.");
    if (wanted > 100) throw field("limit", "NUMBER_TYPE_MAX", "int value should be less than or equal to 100.");
    const before = c.req.query("before");
    const after = c.req.query("after");
    for (const [name, value] of [
      ["before", before],
      ["after", after],
    ] as const) {
      if (value !== undefined && !/^\d{1,20}$/.test(value))
        throw field(name, "NUMBER_TYPE_COERCE", `Value "${value}" is not snowflake.`);
    }
    let messages = store
      .messagesIn(channel.id)
      .filter((message) => message.ephemeralFor === undefined && !message.system);
    if (before) messages = messages.filter((message) => BigInt(message.id) < BigInt(before));
    if (after) messages = messages.filter((message) => BigInt(message.id) > BigInt(after));
    // Newest first, as Discord lists them; `after` gives the oldest ones after it.
    const page = after ? messages.slice(0, wanted).reverse() : messages.slice(-wanted).reverse();
    return { body: page.map((message) => world.messageWire(message)), sessions: sessionOf(channel) };
  });

  limited(
    "get",
    "/channels/:channel/messages/:message",
    "GET /channels/{channel.id}/messages/{message.id}",
    DEFAULT,
    (c) => {
      const channel = channelOf(c);
      world.requireBot(channel, "READ_MESSAGE_HISTORY");
      return {
        body: world.messageWire(messageIn(channel, c.req.param("message") ?? "")),
        sessions: sessionOf(channel),
      };
    },
  );

  limited("post", "/channels/:channel/messages", "POST /channels/{channel.id}/messages", MESSAGES, (c, body) => {
    const channel = channelOf(c);
    world.requireBot(channel, channel.kind === "public_thread" ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES");
    world.checkContent(body);
    const reference = (
      typeof body.message_reference === "object" && body.message_reference !== null ? body.message_reference : {}
    ) as { message_id?: unknown; fail_if_not_exists?: unknown };
    let replyTo: string | undefined;
    if (typeof reference.message_id === "string") {
      const found = store.findMessage(channel.id, reference.message_id);
      if (found) replyTo = found.id;
      else if (reference.fail_if_not_exists !== false) {
        throw new DiscordRefusal(50035, {
          errors: {
            message_reference: { _errors: [{ code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE", message: "Unknown message" }] },
          },
        });
      }
    }
    const message = world.postAsBot(
      channel,
      {
        content: typeof body.content === "string" ? body.content : "",
        embeds: Array.isArray(body.embeds) ? body.embeds : [],
        components: Array.isArray(body.components) ? body.components : [],
      },
      { replyTo },
    );
    return { body: world.messageWire(message), sessions: sessionOf(channel) };
  });

  limited(
    "patch",
    "/channels/:channel/messages/:message",
    "PATCH /channels/{channel.id}/messages/{message.id}",
    DEFAULT,
    (c, body) => {
      const channel = channelOf(c);
      const message = messageIn(channel, c.req.param("message") ?? "");
      if (message.authorId !== store.app.botUserId) throw new DiscordRefusal(50005);
      const next = {
        content: typeof body.content === "string" ? body.content : message.content,
        embeds: Array.isArray(body.embeds) ? body.embeds : message.embeds,
        components: Array.isArray(body.components) ? body.components : message.components,
      };
      world.checkContent(next);
      return { body: world.messageWire(world.update(message, next)), sessions: sessionOf(channel) };
    },
  );

  limited(
    "delete",
    "/channels/:channel/messages/:message",
    "DELETE /channels/{channel.id}/messages/{message.id}",
    DEFAULT,
    (c) => {
      const channel = channelOf(c);
      const message = messageIn(channel, c.req.param("message") ?? "");
      if (message.authorId !== store.app.botUserId) world.requireBot(channel, "MANAGE_MESSAGES");
      world.remove(message);
      return { body: null, sessions: sessionOf(channel), status: 204 };
    },
  );

  /** A reaction's emoji from its path: a Unicode emoji. A custom one (`name:id`) the guild doesn't have is 10014. */
  const emojiOf = (c: Context) => {
    const emoji = decodeURIComponent(c.req.param("emoji") ?? "");
    if (emoji === "" || emoji.includes(":")) throw new DiscordRefusal(10014);
    return emoji;
  };

  const REACTION = "/channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me";
  limited("put", "/channels/:channel/messages/:message/reactions/:emoji/@me", `PUT ${REACTION}`, REACTIONS, (c) => {
    const channel = channelOf(c);
    world.requireBot(channel, "READ_MESSAGE_HISTORY");
    const message = messageIn(channel, c.req.param("message") ?? "");
    const emoji = emojiOf(c);
    if (!message.reactions.some((reaction) => reaction.emoji === emoji)) world.requireBot(channel, "ADD_REACTIONS");
    world.reactAs(message, store.app.botUserId, emoji, "add");
    return { body: null, sessions: sessionOf(channel), status: 204 };
  });

  limited(
    "delete",
    "/channels/:channel/messages/:message/reactions/:emoji/@me",
    `DELETE ${REACTION}`,
    REACTIONS,
    (c) => {
      const channel = channelOf(c);
      const message = messageIn(channel, c.req.param("message") ?? "");
      world.reactAs(message, store.app.botUserId, emojiOf(c), "remove");
      return { body: null, sessions: sessionOf(channel), status: 204 };
    },
  );

  limited(
    "get",
    "/channels/:channel/messages/:message/reactions/:emoji",
    "GET /channels/{channel.id}/messages/{message.id}/reactions/{emoji}",
    DEFAULT,
    (c) => {
      const channel = channelOf(c);
      const message = messageIn(channel, c.req.param("message") ?? "");
      const emoji = emojiOf(c);
      const users = message.reactions.find((reaction) => reaction.emoji === emoji)?.users ?? [];
      return {
        body: users.flatMap((id) => {
          const author = world.authorOf(id);
          return author ? [userObject(author)] : [];
        }),
        sessions: sessionOf(channel),
      };
    },
  );

  limited("post", "/channels/:channel/typing", "POST /channels/{channel.id}/typing", DEFAULT, (c) => {
    const channel = channelOf(c);
    world.requireBot(channel, "SEND_MESSAGES");
    world.typing(channel);
    return { body: null, sessions: sessionOf(channel), status: 204 };
  });

  const threadName = (body: Record<string, unknown>) => {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      throw new DiscordRefusal(50035, {
        errors: { name: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] } },
      });
    }
    return body.name;
  };

  limited(
    "post",
    "/channels/:channel/messages/:message/threads",
    "POST /channels/{channel.id}/messages/{message.id}/threads",
    DEFAULT,
    (c, body) => {
      const channel = channelOf(c);
      world.requireBot(channel, "CREATE_PUBLIC_THREADS");
      if (channel.kind !== "text") throw new DiscordRefusal(50013);
      const message = messageIn(channel, c.req.param("message") ?? "");
      const thread = world.threadAs(store.app.botUserId, channel, threadName(body), message);
      return { body: world.channelWire(thread), sessions: sessionOf(channel), status: 201 };
    },
  );

  limited("post", "/channels/:channel/threads", "POST /channels/{channel.id}/threads", DEFAULT, (c, body) => {
    const channel = channelOf(c);
    world.requireBot(channel, "CREATE_PUBLIC_THREADS");
    if (channel.kind !== "text") throw new DiscordRefusal(50013);
    // A public thread (11, the default). A private one (12) isn't in the fake: refused, never made public instead.
    if (body.type !== undefined && body.type !== 11) {
      throw new DiscordRefusal(50035, {
        message: "Invalid Form Body: the fake makes public threads only (type 11)",
        errors: { type: { _errors: [{ code: "BASE_TYPE_CHOICES", message: "Value must be one of {11}." }] } },
      });
    }
    const thread = world.threadAs(store.app.botUserId, channel, threadName(body), undefined);
    return { body: world.channelWire(thread), sessions: sessionOf(channel), status: 201 };
  });

  for (const method of ["put", "delete"] as const) {
    limited(
      method,
      "/channels/:channel/thread-members/@me",
      `${method.toUpperCase()} /channels/{channel.id}/thread-members/@me`,
      DEFAULT,
      (c) => {
        const channel = channelOf(c);
        if (channel.kind !== "public_thread") throw new DiscordRefusal(50035, { message: "Invalid Form Body" });
        if (method === "put") channel.members.add(store.app.botUserId);
        else channel.members.delete(store.app.botUserId);
        return { body: null, sessions: sessionOf(channel), status: 204 };
      },
    );
  }

  // --- The guild ----------------------------------------------------------------------------

  limited("get", "/guilds/:guild", "GET /guilds/{guild.id}", DEFAULT, (c) => ({
    body: { ...guildObject(guildOf(c), roles()), approximate_member_count: undefined },
    sessions: [],
  }));
  limited("get", "/guilds/:guild/roles", "GET /guilds/{guild.id}/roles", DEFAULT, (c) => {
    guildOf(c);
    return { body: roles(), sessions: [] };
  });
  limited("get", "/guilds/:guild/channels", "GET /guilds/{guild.id}/channels", DEFAULT, (c) => {
    guildOf(c);
    const visible = store
      .allChannels()
      .filter((channel) => channel.kind === "text" && has(world.botPermissions(channel), "VIEW_CHANNEL"));
    return { body: visible.map(world.channelWire), sessions: visible.map((channel) => world.sessionOf(channel.id)) };
  });
  limited("get", "/guilds/:guild/members/:user", "GET /guilds/{guild.id}/members/{user.id}", DEFAULT, (c) => {
    guildOf(c);
    const id = c.req.param("user") ?? "";
    const author = world.authorOf(id);
    if (!author) throw new DiscordRefusal(10013);
    return {
      body: { ...memberObject(world.rolesOf(id), JOINED_AT), user: userObject(author) },
      sessions: author.kind === "user" ? [store.users.owner(id)] : [],
    };
  });

  // --- Application commands -------------------------------------------------------------------

  const appOf = (c: Context) => {
    if (c.req.param("application") !== store.app.id) throw new DiscordRefusal(50001);
  };
  const scopes: ReadonlyArray<readonly [string, string, (c: Context) => string | undefined]> = [
    ["/applications/:application/commands", "/applications/{application.id}/commands", () => undefined],
    [
      "/applications/:application/guilds/:guild/commands",
      "/applications/{application.id}/guilds/{guild.id}/commands",
      (c) => guildOf(c).id,
    ],
  ];
  for (const [path, named, guildIdOf] of scopes) {
    limited("get", path, `GET ${named}`, DEFAULT, (c) => {
      appOf(c);
      return { body: world.interactions.commands(guildIdOf(c)).map(world.interactions.commandWire), sessions: [] };
    });
    limited("put", path, `PUT ${named}`, DEFAULT, (c, body) => {
      appOf(c);
      const list: unknown = body;
      if (!Array.isArray(list)) throw new DiscordRefusal(50035, { message: "Invalid Form Body" });
      const saved = world.interactions.saveCommands(guildIdOf(c), list as Record<string, unknown>[], true);
      return { body: saved.map(world.interactions.commandWire), sessions: [] };
    });
    limited("post", path, `POST ${named}`, DEFAULT, (c, body) => {
      appOf(c);
      const [saved] = world.interactions.saveCommands(guildIdOf(c), [body], false);
      return { body: saved ? world.interactions.commandWire(saved) : {}, sessions: [], status: 201 };
    });
    limited("delete", `${path}/:command`, `DELETE ${named}/{command.id}`, DEFAULT, (c) => {
      appOf(c);
      const id = c.req.param("command") ?? "";
      const found = store.commands.get(id);
      if (!found || found.guildId !== guildIdOf(c)) throw new DiscordRefusal(10063);
      store.commands.delete(id);
      return { body: null, sessions: [], status: 204 };
    });
  }

  // --- Interactions: the response, followups, the original ---------------------------------------

  endpoint(
    "post",
    "/interactions/:interaction/:token/callback",
    "POST /interactions/{interaction.id}/{interaction.token}/callback",
    (c, body) => {
      const id = c.req.param("interaction") ?? "";
      const { message } = world.interactions.callback(id, c.req.param("token") ?? "", body);
      const session = store.interactions.get(id)?.session;
      if (c.req.query("with_response") !== "true") return { body: null, sessions: [session], status: 204 };
      return {
        body: {
          interaction: {
            id,
            type: store.interactions.get(id)?.type,
            activity_instance_id: null,
            response_message_id: message?.id ?? null,
            response_message_loading: message !== undefined && (message.flags & MESSAGE_FLAGS.LOADING) !== 0,
            response_message_ephemeral: message?.ephemeralFor !== undefined,
          },
          // A resource only for a response that made or changed a message (4, 7), as Discord's description has it.
          ...(message && (body.type === 4 || body.type === 7)
            ? { resource: { type: body.type, message: world.messageWire(message) } }
            : {}),
        },
        sessions: [session],
      };
    },
  );

  const WEBHOOK = "/webhooks/{application.id}/{interaction.token}";
  endpoint("post", "/webhooks/:application/:token", `POST ${WEBHOOK}`, (c, body) => {
    const interaction = world.interactions.byToken(c.req.param("application") ?? "", c.req.param("token") ?? "");
    const message = world.interactions.followup(interaction, body);
    return { body: world.messageWire(message), sessions: [interaction.session] };
  });

  const responseOf = (c: Context) => {
    const interaction = world.interactions.byToken(c.req.param("application") ?? "", c.req.param("token") ?? "");
    const which = c.req.param("message") ?? "";
    const message =
      which === "@original"
        ? world.interactions.original(interaction)
        : store.findMessage(interaction.channelId, which);
    if (!message || (message.interaction?.id !== interaction.id && which !== "@original"))
      throw new DiscordRefusal(10008);
    return { interaction, message };
  };
  const MESSAGE = `${WEBHOOK}/messages/{message.id}`;
  endpoint("get", "/webhooks/:application/:token/messages/:message", `GET ${MESSAGE}`, (c) => {
    const { interaction, message } = responseOf(c);
    return { body: world.messageWire(message), sessions: [interaction.session] };
  });
  endpoint("patch", "/webhooks/:application/:token/messages/:message", `PATCH ${MESSAGE}`, (c, body) => {
    const { interaction, message } = responseOf(c);
    return {
      body: world.messageWire(world.interactions.editResponse(interaction, message, body)),
      sessions: [interaction.session],
    };
  });
  endpoint("delete", "/webhooks/:application/:token/messages/:message", `DELETE ${MESSAGE}`, (c) => {
    const { interaction, message } = responseOf(c);
    world.remove(message);
    return { body: null, sessions: [interaction.session], status: 204 };
  });

  const routes = finish();
  // The API's versions the clients use, at the paths Discord serves them. Anything else is Discord's 404.
  const outer = new Hono();
  for (const version of ["v10", "v9"]) outer.route(`/api/${version}`, routes);
  outer.all("*", (c) => c.json({ message: "404: Not Found", code: 0 }, 404));
  return outer;
}
