import { z } from "@hono/zod-openapi";

import { BUILT_IN_APP, HANDLE_ONLY } from "../../core/apps/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { deliveryTo } from "../../core/delivery/kit.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport, type Reality } from "../../core/reality/index.ts";
import {
  type DeliveryView,
  type DriverRouter,
  pathParam,
  refTo,
  registerInspectionRoutes,
} from "../../core/router/index.ts";
import {
  apiCallSchema,
  DeliveryAttempt,
  DeliveryStatus,
  duration,
  principalSchema,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import type { FakeDiscordWorld } from "./fake/world.ts";
import { snowflakeTime } from "./ids.ts";
import { renderTranscript } from "./transcript.ts";
import {
  type DiscordAppRecord,
  type DiscordChannelRecord,
  discordErrors,
  type DiscordMessageRecord,
  type DiscordUserRecord,
  type DiscordWorld,
  NO_BOT_DMS,
  NO_INTERACTIONS,
} from "./world.ts";

const DiscordUser = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("user"),
    channel: z.literal("discord"),
    username: z.string(),
    isAdmin: z.boolean(),
    isBot: z.boolean(),
  })
  .openapi("DiscordUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const DiscordApp = z
  .object({
    id: z.string().openapi({ description: "The application's id, which is also its bot user's." }),
    name: z.string(),
    kind: z.literal("app"),
    channel: z.literal("discord"),
    botUserId: z.string(),
    botToken: z.string().openapi({ description: `The bot token the agent logs in with. ${HANDLE_ONLY}` }),
    publicKey: z
      .string()
      .openapi({ description: "The application's public key, which interactions are verified with." }),
    guildId: z.string(),
  })
  .openapi("DiscordApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const DiscordParticipant = z.discriminatedUnion("kind", [DiscordUser, DiscordApp]);

const DiscordChannel = z
  .object({
    id: z.string(),
    kind: z.enum(["text", "dm", "public_thread"]).openapi({ description: "A guild text channel, a DM, or a thread." }),
    channel: z.literal("discord"),
    name: z.string().optional().openapi({ description: "Without `#`. Undefined for a DM." }),
    parentId: z.string().optional().openapi({ description: "For a thread: the channel it is in." }),
    starterId: z.string().optional().openapi({ description: "For a thread started from a message: that message." }),
  })
  .openapi("DiscordChannel", { "x-channelstack-resource": { id: "id", role: "resource" } });

const DiscordDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("discord"),
    app: z.string().openapi({ description: "The app it went to, by name: `my-agent`, or another (decision 0027)." }),
    type: z
      .string()
      .openapi({ description: "The Gateway event (`MESSAGE_CREATE`, `INTERACTION_CREATE`, …), or `PING`." }),
    payload: z.unknown().openapi({ description: "The dispatch's `d`, or the interaction's body." }),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("DiscordDelivery", { "x-channelstack-resource": { id: "id" } });

const DiscordMessage = z
  .object({
    id: z.string(),
    channelId: z.string(),
    channel: DiscordChannel,
    author: DiscordParticipant,
    text: z.string().openapi({ description: "What a person reads: mentions as `@name`, embeds' text below." }),
    content: z.string().openapi({ description: "The message's `content` as Discord keeps it, mentions as `<@id>`." }),
    embeds: z.array(z.unknown()),
    components: z.array(z.unknown()),
    postedAt: z.string(),
    edited: z.boolean(),
    replyTo: z.string().optional().openapi({ description: "The message this one replies to." }),
    /** The thread started from this message. */
    thread: DiscordChannel.optional(),
    /** For an ephemeral response: the only person who sees it. */
    visibleTo: DiscordUser.optional(),
    /** The Gateway dispatch that told the built-in app's bot of it (`MESSAGE_CREATE`); another app's is `deliveryFor(app)`. */
    delivery: DiscordDelivery.optional(),
  })
  .openapi("DiscordMessage", { "x-channelstack-resource": { id: ["channelId", "id"] } });

const Principal = principalSchema("DiscordPrincipal");

const DiscordTranscript = transcriptSchema("Discord", Principal, {
  replyTo: z.string().optional().openapi({ description: "Whose message this one replies to." }),
  streaming: z.literal("open").optional().openapi({ description: "A deferred response: the app is still thinking." }),
  visibleTo: Principal.optional(),
});

const DiscordApiCall = apiCallSchema("discord", "DiscordApiCall");

const DiscordFixture = z
  .object({
    app: DiscordApp,
    apiUrl: z.string().openapi({ description: "Where the agent's REST client goes: discord.js's `rest.api`." }),
    guild: z.object({ id: z.string(), name: z.string() }).openapi("DiscordGuild"),
    gatewayConnections: z.number().int().openapi({ description: "How many Gateway connections the bot holds open." }),
  })
  .openapi("DiscordFixture", { "x-channelstack-resource": {} });

const MessageInput = z
  .object({ content: z.string().optional(), embeds: z.array(z.unknown()).optional() })
  .openapi("DiscordMessageInput", { "x-channelstack-shorthand": "content" });

const participantRef = z.string().openapi(refTo("DiscordUser", "DiscordApp"));
const participants = () => z.array(participantRef).min(1).openapi({ "x-channelstack-one-or-many": true });
const channelRef = z.string().openapi(refTo("DiscordChannel"));
const messageRef = z.object({ channelId: z.string(), id: z.string() }).openapi(refTo("DiscordMessage"));

const UserParams = z.object({ user: pathParam("user") });
const AppParams = z.object({ app: pathParam("app") });
const ChannelParams = z.object({ channel: pathParam("channel") });
const MessageParams = ChannelParams.extend({ message: pathParam("message") });
const messageBinding = { channel: "channelId", message: "id" };

/** What only the agent's own calls show (ephemeral responses): live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason:
    "Discord shows an ephemeral message to its person alone, and no bot API reads it back; proxy mode sees the agent's own calls",
};
/**
 * A fault changes what the bot's own calls and its Gateway connection get. Live, nothing sits
 * between the bot's Gateway and Discord (discord.js's WebSocket doesn't go through the proxy, decision
 * 0026), and a rate limit through the proxy isn't built yet: both are fake-only.
 */
const FAULTS: LiveSupport = {
  unsupported:
    "a fault changes what the bot's calls and its Gateway connection get, and live nothing sits between the bot and Discord: its Gateway doesn't go through the proxy",
};
/** Live, the guild holds only the app channelstack has credentials for: decision 0027's live apps aren't built yet (#111). */
const APPS_NOT_YET: LiveSupport = {
  unsupported: "not yet: live, the guild holds only the app channelstack has credentials for",
};
const PORTAL: LiveSupport = {
  unsupported: "Discord checks an interactions endpoint when it is saved in the developer portal, which no API does",
};

/** The Discord driver's control API: what a test's people do, and what a test reads back. */
export function registerDiscordRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeDiscordWorld;
    live: DiscordWorld | undefined;
    reality: () => Reality;
    events: EventLog;
    apiUrl: () => string;
    /** One of an app's secrets: the built-in app's unless another is named. */
    secret: (name: string, app?: string) => string;
    /** An app's public key: the built-in app's unless another is named. */
    publicKey: (app?: string) => string;
  },
): void {
  const { fake } = deps;
  const world: DiscordWorld = deps.live ?? fake;
  const stability = "experimental";
  const isLive = () => deps.reality() === "live";

  const userWire = (user: DiscordUserRecord) => ({
    id: user.id,
    name: user.name,
    kind: "user" as const,
    channel: "discord" as const,
    username: user.username,
    isAdmin: user.admin,
    isBot: user.bot,
  });
  /**
   * An app as an author or a member: who it is, without its bot token. Only the app a test asks
   * for (the fixture's, `createApp`, `apps()`) carries it: `appHandle`.
   */
  const appWire = (app: DiscordAppRecord) => ({
    id: app.id,
    name: app.name,
    kind: "app" as const,
    channel: "discord" as const,
    botUserId: app.botUserId,
    botToken: "",
    publicKey: isLive() ? "" : deps.publicKey(app.name),
    guildId: world.guild().id,
  });
  // A live bot's token stays on the server: the control API never returns it.
  const appHandle = (app: DiscordAppRecord) => ({
    ...appWire(app),
    botToken: isLive() ? "" : deps.secret("botToken", app.name),
  });
  /** The app whose bot this is: live, only the built-in one. */
  const appOf = (id: string) => (id === world.app().botUserId ? world.app() : isLive() ? undefined : fake.appOf(id));
  const participantWire = (session: string, id: string) => {
    const app = appOf(id);
    return app ? appWire(app) : userWire(world.user(session, id));
  };
  const channelWire = (channel: DiscordChannelRecord) => ({
    id: channel.id,
    kind: channel.kind,
    channel: "discord" as const,
    name: channel.name,
    parentId: channel.parentId,
    starterId: channel.starterId,
  });
  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "discord" as const,
    app: request.app ?? BUILT_IN_APP,
    type: request.type,
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });

  /** The name a mention shows as, or nothing for an id that is nobody this session knows. */
  const mentionName = (session: string) => (id: string) => {
    try {
      return participantWire(session, id).name;
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "not_found") return undefined;
      throw error;
    }
  };
  const principal = (session: string) => (id: string) => {
    const name = mentionName(session)(id);
    return { id, name: name ?? id, kind: appOf(id) ? ("app" as const) : ("user" as const) };
  };
  const plainText = (session: string, message: DiscordMessageRecord) =>
    renderTranscript([{ message: { ...message, ephemeralFor: undefined }, depth: 0 }], {
      viewer: undefined,
      principal: principal(session),
      mentionName: mentionName(session),
      replyAuthor: () => undefined,
    }).entries[0]?.text ?? "";

  const messageWire = async (session: string, message: DiscordMessageRecord) => {
    const channel = world.channel(session, message.channelId);
    const thread = message.threadId === undefined ? undefined : world.channel(session, message.threadId);
    return {
      id: message.id,
      channelId: message.channelId,
      channel: channelWire(channel),
      author: participantWire(session, message.authorId),
      text: plainText(session, message),
      content: message.content,
      embeds: message.embeds,
      components: message.components,
      postedAt: snowflakeTime(message.id),
      edited: message.editedAt !== undefined,
      replyTo: message.replyTo,
      thread: thread ? channelWire(thread) : undefined,
      visibleTo: message.ephemeralFor === undefined ? undefined : userWire(world.user(session, message.ephemeralFor)),
      // Only the fake delivers: a live message never has a delivery here. It is the first to the
      // built-in app; another app's are `msg.deliveryFor(app)` (decision 0027).
      delivery: deps.live ? undefined : deliveryOf(session, message.deliveries),
    };
  };
  /** A message's delivery to this app (core's pick among those it caused), as a test reads it. */
  const deliveryOf = (session: string, ids: readonly string[], app?: string) => {
    const record = deliveryTo(
      ids.map((id) => fake.delivery(session, id)),
      app,
    );
    return record && deliveryWire(record);
  };
  const messagesWire = (session: string, messages: readonly DiscordMessageRecord[]) =>
    Promise.all(messages.map((message) => messageWire(session, message)));
  /** The delivery an action caused, or null where Discord tells the bot itself (live) or nothing was sent. */
  const deliveryOrNull = (session: string, id: string | undefined) =>
    id === undefined || deps.live ? null : deliveryWire(fake.delivery(session, id) as DeliveryRecord);

  /** A transcript of messages as a person reads them: what each replies to by its author's name. */
  const transcript = async (
    session: string,
    lines: ReadonlyArray<{ message: DiscordMessageRecord; depth: number }>,
    viewer: string | undefined,
  ) => {
    const authors = new Map<string, string>();
    for (const { message } of lines) authors.set(message.id, message.authorId);
    const replyAuthor = (message: DiscordMessageRecord) => {
      const author = message.replyTo === undefined ? undefined : authors.get(message.replyTo);
      return author === undefined ? undefined : mentionName(session)(author);
    };
    return renderTranscript(lines, {
      viewer,
      principal: principal(session),
      mentionName: mentionName(session),
      replyAuthor,
    });
  };

  /** A channel as a person scrolls through it: each message, and under one that starts a thread, the thread's. */
  const channelLines = async (session: string, channel: string, viewer: string | undefined) => {
    const all = await world.messages(session, channel);
    const own =
      viewer === undefined || deps.live ? [] : fake.store.messagesIn(channel).filter((m) => m.ephemeralFor === viewer);
    const messages = [...all, ...own].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const lines: Array<{ message: DiscordMessageRecord; depth: number }> = [];
    for (const message of messages) {
      lines.push({ message, depth: 0 });
      if (message.threadId !== undefined) {
        for (const reply of await world.messages(session, message.threadId)) lines.push({ message: reply, depth: 1 });
      }
    }
    return lines;
  };

  router.route({
    method: "get",
    path: "",
    summary: "The Discord fixture: the agent's app, the guild, and where the agent reaches the fake",
    response: DiscordFixture,
    factory: { on: "Session", name: "discord" },
    stability,
    handler: () => ({
      app: appHandle(world.app()),
      apiUrl: isLive() ? "https://discord.com/api" : `${deps.apiUrl()}/api`,
      guild: { id: world.guild().id, name: world.guild().name },
      gatewayConnections: world.gatewayConnections(),
    }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person in the guild",
    body: z
      .object({
        name: z.string().min(1),
        id: z.string().min(1).optional().openapi({
          description:
            "A fixed user id (a snowflake), for agents that allowlist people by id. Fake only: live, the person has their bot's id.",
        }),
        admin: z.boolean().optional().openapi({ description: "Has the guild's Admin role (`ADMINISTRATOR`)." }),
        bot: z
          .boolean()
          .optional()
          .openapi({ description: "Another bot, not the agent's: what it writes carries `author.bot`." }),
        token: z.string().min(1).optional().openapi({
          description:
            "Live: the bot token of a second application in the sandbox guild, which acts as this person through Discord's API (Discord has no API that acts as a person). What it writes carries `author.bot`. Read from CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_DISCORD_USER_{name}_TOKEN",
        }),
      })
      .openapi("DiscordUserOptions"),
    response: DiscordUser,
    errors: ["not_found"],
    factory: { on: "DiscordFixture", name: "createUser", options: ["name", "id", "admin", "bot", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  router.route({
    method: "post",
    path: "/apps",
    summary:
      "Make another app in the guild, with its own application, bot user, token and Ed25519 key (decision 0027), or return the one made with this name and settings. Its bot connects to the Gateway with its own token; its interactions go to CHANNELSTACK_DISCORD_APP_<NAME>_WEBHOOK_URL, or over its Gateway connection",
    body: z
      .object({
        name: z
          .string()
          .min(1)
          .openapi({ description: "How people mention it: 1 to 32 lower-case letters, digits and hyphens" }),
        privilegedIntents: z
          .array(z.enum(["GUILD_MEMBERS", "GUILD_PRESENCES", "MESSAGE_CONTENT"]))
          .optional()
          .openapi({
            description:
              "The privileged intents switched on in its developer portal. Default: the built-in app's (`GUILD_MEMBERS`, `MESSAGE_CONTENT`)",
          }),
      })
      .openapi("DiscordAppOptions"),
    response: DiscordApp,
    errors: ["invalid_argument"],
    factory: { on: "DiscordFixture", name: "createApp", options: ["name", "privilegedIntents"] },
    live: APPS_NOT_YET,
    stability,
    handler: ({ session, body }) => appHandle(fake.createApp(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/apps",
    summary: "The guild's apps: the built-in one first, then the others in the order they were made",
    response: z.array(DiscordApp).openapi("DiscordApps"),
    sdkMethod: { on: "DiscordFixture", name: "apps" },
    live: APPS_NOT_YET,
    stability,
    handler: () => fake.apps().map(appHandle),
  });

  router.route({
    method: "post",
    path: "/apps/{app}/say",
    summary:
      "An app a test made writes, as its own `POST /channels/{id}/messages` would: in a channel or thread its bot sees, or in a DM with the person in `to`. No bot writes to another bot in a DM (50007)",
    params: AppParams,
    body: z
      .object({ text: MessageInput, channel: channelRef.optional(), to: participants().optional() })
      .openapi("DiscordAppSayBody"),
    response: DiscordMessage,
    errors: ["not_found", "invalid_argument", ...discordErrors(50001, 50006, 50007, 50013, 50035)],
    sdkMethod: { on: "DiscordApp", name: "say", args: ["text"], options: ["channel", "to"] },
    live: APPS_NOT_YET,
    stability,
    handler: async ({ session, params, body }) => {
      if ((body.channel === undefined) === (body.to === undefined)) {
        throw new ProtocolError("invalid_argument", "say needs exactly one of `channel` and `to`");
      }
      const where = body.channel !== undefined ? { channel: body.channel } : { to: body.to ?? [] };
      return messageWire(session.id, fake.sayAsApp(session.id, params.app, body.text, where));
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/reply",
    summary: "An app a test made replies to a message: Discord's reply, in the message's channel, which quotes it",
    params: AppParams,
    body: z.object({ text: MessageInput, message: messageRef }).openapi("DiscordAppReplyBody"),
    response: DiscordMessage,
    errors: ["not_found", "invalid_argument", ...discordErrors(50001, 50006, 50013, 50035)],
    sdkMethod: { on: "DiscordApp", name: "reply", args: ["text"], options: ["message"] },
    live: APPS_NOT_YET,
    stability,
    handler: async ({ session, params, body }) =>
      messageWire(
        session.id,
        fake.replyAsApp(session.id, params.app, body.text, { channel: body.message.channelId, id: body.message.id }),
      ),
  });

  for (const [name, direction] of [
    ["react", "add"],
    ["unreact", "remove"],
  ] as const) {
    router.route({
      method: "post",
      path: `/apps/{app}/${name}`,
      summary:
        direction === "add" ? "An app a test made reacts to a message" : "An app a test made takes its reaction back",
      params: AppParams,
      body: z
        .object({ emoji: z.string().min(1), message: messageRef })
        .openapi(direction === "add" ? "DiscordAppReactBody" : "DiscordAppUnreactBody"),
      response: DiscordDelivery.nullable(),
      errors: ["not_found", "invalid_argument", ...discordErrors(50001, 50013)],
      sdkMethod: { on: "DiscordApp", name, args: ["emoji"], options: ["message"] },
      live: APPS_NOT_YET,
      stability,
      handler: ({ session, params, body }) =>
        deliveryOrNull(
          session.id,
          fake.reactAsApp(
            session.id,
            params.app,
            body.emoji,
            { channel: body.message.channelId, id: body.message.id },
            direction,
          ),
        ),
    });
  }

  router.route({
    method: "get",
    path: "/users",
    summary: "The people this session created",
    response: z.array(DiscordUser).openapi("DiscordUsers"),
    sdkMethod: { on: "DiscordFixture", name: "users" },
    stability,
    handler: ({ session }) => world.users(session.id).map(userWire),
  });

  router.route({
    method: "post",
    path: "/channels",
    summary:
      "Create a text channel. Only the listed participants see it (a private channel); include the app for the bot to hear it",
    body: z
      .object({
        name: z.string().min(1).max(100).optional(),
        participants: z.array(participantRef).default([]),
        readOnly: z.boolean().optional().openapi({ description: "Everyone reads; only admins write." }),
        topic: z.string().optional(),
      })
      .openapi("DiscordChannelOptions"),
    response: DiscordChannel,
    errors: ["not_found"],
    factory: { on: "DiscordFixture", name: "createChannel", options: ["name", "participants", "readOnly", "topic"] },
    stability,
    handler: async ({ session, body }) => channelWire(await world.createChannel(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/channels",
    summary: "The session's channels, threads and DMs",
    response: z.array(DiscordChannel).openapi("DiscordChannels"),
    sdkMethod: { on: "DiscordFixture", name: "channels" },
    stability,
    handler: async ({ session }) => (await world.channels(session.id)).map(channelWire),
  });

  const writeErrors = ["not_found", ...discordErrors(50001, 50006, 50013, 50035)];

  router.route({
    method: "post",
    path: "/users/{user}/say",
    summary: "Write a message in a channel or thread, or in a DM with the person or app in `to`",
    params: UserParams,
    body: z
      .object({ text: MessageInput, channel: channelRef.optional(), to: participants().optional() })
      .openapi("DiscordSayBody"),
    response: DiscordMessage,
    errors: writeErrors,
    sdkMethod: { on: "DiscordUser", name: "say", args: ["text"], options: ["channel", "to"] },
    stability,
    handler: async ({ session, params, body }) => {
      if ((body.channel === undefined) === (body.to === undefined)) {
        throw new ProtocolError("invalid_argument", "say needs exactly one of `channel` and `to`");
      }
      const where = body.channel !== undefined ? { channel: body.channel } : { to: body.to ?? [] };
      return messageWire(session.id, await world.say(session.id, params.user, body.text, where));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/reply",
    summary: "Reply to a message: Discord's reply, in the message's channel, which quotes it",
    params: UserParams,
    body: z.object({ text: MessageInput, message: messageRef }).openapi("DiscordReplyBody"),
    response: DiscordMessage,
    errors: writeErrors,
    sdkMethod: { on: "DiscordUser", name: "reply", args: ["text"], options: ["message"] },
    stability,
    handler: async ({ session, params, body }) =>
      messageWire(
        session.id,
        await world.reply(session.id, params.user, body.text, { channel: body.message.channelId, id: body.message.id }),
      ),
  });

  router.route({
    method: "post",
    path: "/users/{user}/edit",
    summary: "Edit one of this person's own messages",
    params: UserParams,
    body: z.object({ text: MessageInput, message: messageRef }).openapi("DiscordEditBody"),
    response: DiscordMessage,
    errors: ["not_found", ...discordErrors(50005, 50006, 50035)],
    sdkMethod: { on: "DiscordUser", name: "edit", args: ["text"], options: ["message"] },
    stability,
    handler: async ({ session, params, body }) =>
      messageWire(
        session.id,
        await world.edit(session.id, params.user, body.text, { channel: body.message.channelId, id: body.message.id }),
      ),
  });

  router.route({
    method: "post",
    path: "/users/{user}/delete",
    summary: "Delete a message: this person's own, or anyone's for an admin",
    params: UserParams,
    body: z.object({ message: messageRef }).openapi("DiscordDeleteBody"),
    errors: ["not_found", ...discordErrors(50013)],
    sdkMethod: { on: "DiscordUser", name: "delete", options: ["message"] },
    stability,
    handler: async ({ session, params, body }) => {
      await world.delete(session.id, params.user, { channel: body.message.channelId, id: body.message.id });
    },
  });

  for (const [name, direction] of [
    ["react", "add"],
    ["unreact", "remove"],
  ] as const) {
    router.route({
      method: "post",
      path: `/users/{user}/${name}`,
      summary: direction === "add" ? "React to a message with an emoji" : "Take this person's reaction off a message",
      params: UserParams,
      body: z
        .object({ emoji: z.string().min(1), message: messageRef })
        .openapi(direction === "add" ? "DiscordReactBody" : "DiscordUnreactBody"),
      response: DiscordDelivery.nullable(),
      errors: ["not_found", ...discordErrors(50013)],
      sdkMethod: { on: "DiscordUser", name, args: ["emoji"], options: ["message"] },
      stability,
      handler: async ({ session, params, body }) =>
        deliveryOrNull(
          session.id,
          await world.react(
            session.id,
            params.user,
            body.emoji,
            { channel: body.message.channelId, id: body.message.id },
            direction,
          ),
        ),
    });
  }

  router.route({
    method: "post",
    path: "/users/{user}/threads",
    summary: "Start a thread: from a message, or in a channel",
    params: UserParams,
    body: z
      .object({ name: z.string().min(1).max(100), message: messageRef.optional(), channel: channelRef.optional() })
      .openapi("DiscordStartThreadBody"),
    response: DiscordChannel,
    errors: ["not_found", ...discordErrors(50013, 160004)],
    sdkMethod: { on: "DiscordUser", name: "startThread", args: ["name"], options: ["message", "channel"] },
    stability,
    handler: async ({ session, params, body }) => {
      if ((body.message === undefined) === (body.channel === undefined)) {
        throw new ProtocolError("invalid_argument", "startThread needs exactly one of `message` and `channel`");
      }
      const from = body.message
        ? { message: { channel: body.message.channelId, id: body.message.id } }
        : { channel: body.channel ?? "" };
      return channelWire(await world.startThread(session.id, params.user, body.name, from));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/open-dm",
    summary: "Open (or reuse) a DM with the app or another person",
    params: UserParams,
    body: z.object({ participant: participantRef }).openapi("DiscordOpenDmBody"),
    response: DiscordChannel,
    errors: ["not_found"],
    sdkMethod: { on: "DiscordUser", name: "openDM", args: ["participant"] },
    live: { unsupported: NO_BOT_DMS },
    stability,
    handler: async ({ session, params, body }) =>
      channelWire(await world.openDM(session.id, params.user, body.participant)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/invite",
    summary: "Let people or the app see a channel. The person must be an admin",
    params: UserParams,
    body: z.object({ participants: participants(), channel: channelRef }).openapi("DiscordInviteBody"),
    errors: ["not_found", ...discordErrors(50013)],
    sdkMethod: { on: "DiscordUser", name: "invite", args: ["participants"], options: ["channel"] },
    stability,
    handler: async ({ session, params, body }) => {
      await world.invite(session.id, params.user, body.participants, body.channel);
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/commands",
    summary:
      "Run one of an app's slash commands in a channel, e.g. `/deploy web staging` or `/deploy service:web`: the built-in app's, or `app`'s, as a person picks one app's command when several have it",
    params: UserParams,
    body: z
      .object({
        command: z.string().regex(/^\/\S/),
        channel: channelRef,
        app: z
          .string()
          .optional()
          .openapi({
            description:
              "Whose command: an app's id or name. Default: the built-in app's when it has a command of that name, or another app's that has one (decision 0027)",
            ...refTo("DiscordApp"),
          }),
      })
      .openapi("DiscordCommandBody"),
    // The interaction's delivery; none live, where Discord tells the agent itself.
    response: DiscordDelivery.nullable(),
    errors: ["not_found", ...discordErrors(50013)],
    // The agent registers its commands when it starts: a person waits until the command is there.
    sdkMethod: {
      on: "DiscordUser",
      name: "runCommand",
      args: ["command"],
      options: ["channel", "app"],
      retryWhile: ["not_found"],
    },
    live: { unsupported: NO_INTERACTIONS },
    stability,
    handler: async ({ session, params, body }) =>
      deliveryOrNull(session.id, await world.runCommand(session.id, params.user, body.command, body.channel, body.app)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/click",
    summary:
      "Press a button, found by its label or custom_id: on a message, or on the app's newest message in a channel or thread that has it",
    params: UserParams,
    body: z
      .object({
        button: z
          .object({ label: z.string().optional(), customId: z.string().optional() })
          .openapi("DiscordButtonRef", { "x-channelstack-shorthand": "label" }),
        message: messageRef.optional(),
        channel: channelRef.optional(),
      })
      .openapi("DiscordClickBody"),
    response: DiscordDelivery.nullable(),
    errors: ["not_found"],
    // A person waits for the button to appear before they press it.
    sdkMethod: {
      on: "DiscordUser",
      name: "click",
      args: ["button"],
      options: ["message", "channel"],
      retryWhile: ["not_found"],
    },
    live: { unsupported: NO_INTERACTIONS },
    stability,
    handler: async ({ session, params, body }) => {
      if ((body.message === undefined) === (body.channel === undefined)) {
        throw new ProtocolError("invalid_argument", "click needs exactly one of `message` and `channel`");
      }
      if (body.button.label === undefined && body.button.customId === undefined) {
        throw new ProtocolError("invalid_argument", "Say which button: its label or its custom_id");
      }
      const where = body.message
        ? { message: { channel: body.message.channelId, id: body.message.id } }
        : { channel: body.channel ?? "" };
      return deliveryOrNull(session.id, await world.click(session.id, params.user, body.button, where));
    },
  });

  router.route({
    method: "get",
    path: "/users/{user}/ephemeral",
    summary: 'Messages only this person sees: the app\'s ephemeral responses, and "This interaction failed"',
    params: UserParams,
    response: z.array(DiscordMessage).openapi("DiscordEphemeralMessages"),
    errors: ["not_found"],
    // What the app answered only this person with: read once it has gone quiet.
    sdkMethod: { on: "DiscordUser", name: "ephemeral", onceQuiet: true },
    live: AGENT_SIDE,
    stability,
    handler: async ({ session, params }) => messagesWire(session.id, await fake.ephemeral(session.id, params.user)),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages",
    summary: "A channel's or thread's messages, oldest first",
    params: ChannelParams,
    response: z.array(DiscordMessage).openapi("DiscordMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordChannel", name: "messages" },
    waits: [{ name: "waitForMessage", mode: "next", from: "author", what: "a message" }],
    stability,
    handler: async ({ session, params }) => messagesWire(session.id, await world.messages(session.id, params.channel)),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/members",
    summary:
      "Who sees a channel: a text channel's participants, a DM's two ends; a thread's are its channel's. Admins see every channel without being listed",
    params: ChannelParams,
    response: z.array(DiscordParticipant).openapi("DiscordMembers"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordChannel", name: "members" },
    stability,
    handler: ({ session, params }) => {
      const channel = world.channel(session.id, params.channel);
      const seen =
        channel.kind === "public_thread" && channel.parentId ? world.channel(session.id, channel.parentId) : channel;
      return [...seen.members].map((id) => participantWire(session.id, id));
    },
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/threads",
    summary: "The threads in a channel",
    params: ChannelParams,
    response: z.array(DiscordChannel).openapi("DiscordThreads"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordChannel", name: "threads" },
    stability,
    handler: async ({ session, params }) => (await world.threads(session.id, params.channel)).map(channelWire),
  });

  /** Who is reading: ephemeral messages show only to their person. */
  const viewer = z
    .string()
    .optional()
    .openapi({ param: { name: "as", in: "query" }, "x-channelstack-ref": ["DiscordUser", "DiscordApp"] });

  router.route({
    method: "get",
    path: "/channels/{channel}/transcript",
    summary: "A channel or thread as a person reads it, each thread under the message that starts it",
    params: ChannelParams,
    query: z.object({ as: viewer }),
    response: DiscordTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "DiscordChannel", name: "transcript", options: ["as"] },
    stability,
    handler: async ({ session, params, query }) =>
      transcript(session.id, await channelLines(session.id, params.channel, query.as), query.as),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}",
    summary: "Re-read a message: its latest text, edits and thread",
    params: MessageParams,
    response: DiscordMessage,
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "refresh", bind: messageBinding },
    stability,
    handler: async ({ session, params }) =>
      messageWire(session.id, await world.message(session.id, params.channel, params.message)),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}/replies",
    summary:
      "What answers a message, oldest first: Discord's replies to it, and the messages of the thread started from it",
    params: MessageParams,
    response: z.array(DiscordMessage).openapi("DiscordReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "replies", bind: messageBinding },
    waits: [
      { name: "waitForReply", mode: "next", from: "author", what: "a reply" },
      { name: "latestReply", mode: "latest", from: "author", what: "a reply" },
    ],
    stability,
    handler: async ({ session, params }) =>
      messagesWire(session.id, await world.replies(session.id, params.channel, params.message)),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}/transcript",
    summary: "A message and what answers it, as a person reads them",
    params: MessageParams,
    query: z.object({ as: viewer }),
    response: DiscordTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "transcript", options: ["as"], bind: messageBinding },
    stability,
    handler: async ({ session, params, query }) => {
      const message = await world.message(session.id, params.channel, params.message);
      const replies = await world.replies(session.id, params.channel, params.message);
      return transcript(
        session.id,
        [{ message, depth: 0 }, ...replies.map((reply) => ({ message: reply, depth: 1 }))],
        query.as,
      );
    },
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}/reactions",
    summary: "The reactions on a message, and who added each",
    params: MessageParams,
    response: z
      .array(z.object({ emoji: z.string(), by: z.array(DiscordParticipant) }).openapi("DiscordReaction"))
      .openapi("DiscordReactions"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "reactions", bind: messageBinding },
    stability,
    handler: async ({ session, params }) =>
      (await world.message(session.id, params.channel, params.message)).reactions.map((reaction) => ({
        emoji: reaction.emoji,
        by: reaction.users.map((id) => participantWire(session.id, id)),
      })),
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}/delivery-for",
    summary:
      "The first Gateway dispatch this message caused to this app's bot (decision 0027), or nothing when it wasn't told",
    params: MessageParams,
    query: z.object({ app: z.string().openapi({ param: { name: "app", in: "query" }, ...refTo("DiscordApp") }) }),
    response: DiscordDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "deliveryFor", args: ["app"], bind: messageBinding },
    live: DELIVERY_IS_THE_PLATFORMS,
    stability,
    handler: async ({ session, params, query }) => {
      const app = fake.roster.get(session.id, query.app);
      const message = await fake.message(session.id, params.channel, params.message);
      return deliveryOf(session.id, message.deliveries, app.name) ?? null;
    },
  });

  router.route({
    method: "get",
    path: "/channels/{channel}/messages/{message}/deliveries",
    summary: "Every Gateway dispatch this message caused to the apps' bots",
    params: MessageParams,
    response: z.array(DiscordDelivery).openapi("DiscordMessageDeliveries"),
    errors: ["not_found"],
    sdkMethod: { on: "DiscordMessage", name: "deliveries", bind: messageBinding },
    live: DELIVERY_IS_THE_PLATFORMS,
    stability,
    handler: async ({ session, params }) =>
      (await fake.message(session.id, params.channel, params.message)).deliveries.map((id) =>
        deliveryWire(fake.delivery(session.id, id)),
      ),
  });

  router.route({
    method: "post",
    path: "/verify-endpoint",
    summary:
      "Discord's check of the app's interactions endpoint, as when it is saved in the developer portal: a PING it must answer with a PONG, and one with a bad signature it must refuse with 401",
    response: z
      .object({
        valid: z.boolean(),
        problems: z.array(z.string()).openapi({ description: "What the endpoint got wrong, in Discord's terms." }),
        deliveries: z.array(z.string()),
      })
      .openapi("DiscordEndpointCheck"),
    sdkMethod: { on: "DiscordFixture", name: "verifyEndpoint" },
    live: PORTAL,
    stability,
    handler: ({ session }) => fake.interactions.verifyEndpoint(session.id),
  });

  registerInspectionRoutes(router, {
    title: "Discord",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: DiscordDelivery, wire: deliveryWire },
    apps: { handle: "DiscordApp", roster: fake.roster },
    listSummary:
      "Every Gateway dispatch and interaction channelstack sent the bot for this session, with every attempt",
    filters: {
      type: "Only this event, e.g. `MESSAGE_CREATE` or `INTERACTION_CREATE`.",
      resource: {
        description: "Only deliveries about this channel or thread.",
        ref: "DiscordChannel",
        matches: ({ request }, channel) => {
          const payload = (request.meta?.payload ?? {}) as { channel_id?: unknown; id?: unknown; parent_id?: unknown };
          return payload.channel_id === channel || payload.id === channel || payload.parent_id === channel;
        },
      },
    },
    live: {
      reads: DELIVERY_IS_THE_PLATFORMS,
      redeliver: { unsupported: "Discord dispatches an event once a session, and has no API to send one again" },
    },
    redeliver: { summary: "Dispatch the same event to the bot again, as a replay after a RESUME would" },
    resend: {
      summary:
        "Send an interaction again, forged: signed with a key that isn't the app's, which its endpoint must refuse with 401",
      options: ["badSignature"],
    },
    calls: {
      schema: DiscordApiCall,
      summary:
        "The REST calls the bot made about this session's channels, messages and interactions, by route (`POST /channels/{channel.id}/messages`). Calls about nothing a session owns (`GET /gateway/bot`) are in no session",
      live: AGENT_SIDE,
    },
  });

  router.route({
    method: "post",
    path: "/faults",
    summary:
      "Inject a fault: rate-limit the bot's calls of a route (removed when this session closes), or drop its Gateway connection just before the next dispatch",
    body: z
      .object({
        type: z.enum(["rate_limit", "drop_gateway"]),
        route: z
          .string()
          .optional()
          .openapi({ description: "For rate_limit: only this route, e.g. `POST /channels/{channel.id}/messages`." }),
        retryAfter: duration("For rate_limit: what `retry_after` says.").default(1000),
        times: z.number().int().min(1).optional(),
        app: z
          .string()
          .optional()
          .openapi({
            description: "Only this app's bot: its calls, or its Gateway connection. Every app's when left out.",
            ...refTo("DiscordApp"),
          }),
      })
      .openapi("DiscordFaultBody"),
    response: z.object({ id: z.string() }).openapi("DiscordFault", { "x-channelstack-resource": { id: "id" } }),
    sdkMethod: { on: "DiscordFixture", name: "fault", options: ["type", "route", "retryAfter", "times", "app"] },
    live: FAULTS,
    stability,
    handler: ({ session, body }) => ({
      id: fake.addFault(session.id, {
        type: body.type,
        route: body.route,
        remaining: body.times,
        retryAfterMs: body.retryAfter,
        app: body.app,
      }),
    }),
  });

  router.route({
    method: "delete",
    path: "/faults/{fault}",
    summary: "Remove a fault",
    params: z.object({ fault: pathParam("fault") }),
    sdkMethod: { on: "DiscordFault", name: "undo", dispose: true },
    live: FAULTS,
    stability,
    handler: ({ session, params }) => fake.removeFault(session.id, params.fault),
  });
}
