import { z } from "@hono/zod-openapi";

import { ProtocolError } from "../../core/errors/index.ts";
import type { DriverRouter } from "../../core/router/index.ts";
import type {
  SlackAppRecord,
  SlackConversationRecord,
  SlackMessageRecord,
  SlackUserRecord,
  SlackWorld,
} from "./world.ts";

const refTo = (...resources: string[]) => ({ "x-channelstack-ref": resources });

const SlackUser = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("user"),
    displayName: z.string(),
    realName: z.string(),
    email: z.string().optional(),
    isAdmin: z.boolean(),
    isBot: z.boolean(),
  })
  .openapi("SlackUser", { "x-channelstack-resource": { id: "id" } });

const SlackApp = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("app"),
    botUserId: z.string(),
    botId: z.string(),
    botToken: z.string(),
    appToken: z.string(),
    signingSecret: z.string(),
    scopes: z.array(z.string()),
  })
  .openapi("SlackApp", { "x-channelstack-resource": { id: "id" } });

const SlackParticipant = z.discriminatedUnion("kind", [SlackUser, SlackApp]);

const SlackConversation = z
  .object({
    id: z.string(),
    kind: z.enum(["channel", "private_channel", "im", "mpim"]),
    name: z.string().optional(),
  })
  .openapi("SlackConversation", { "x-channelstack-resource": { id: "id" } });

const SlackMessage = z
  .object({
    channel: z.string(),
    ts: z.string(),
    conversation: SlackConversation,
    author: SlackParticipant,
    text: z.string(),
    blocks: z.array(z.unknown()),
    postedAt: z.string(),
    threadTs: z.string().optional(),
    edited: z.boolean(),
    visibleTo: SlackUser.optional(),
    deliveries: z.array(z.string()),
    delivery: z.string().optional(),
  })
  .openapi("SlackMessage", { "x-channelstack-resource": { id: ["channel", "ts"] } });

const SlackFixture = z
  .object({
    app: SlackApp,
    apiUrl: z.string(),
    team: z.object({ id: z.string(), name: z.string() }).openapi("SlackTeam"),
  })
  .openapi("SlackFixture", { "x-channelstack-resource": {} });

const SlackReactions = z
  .array(z.object({ emoji: z.string(), by: z.array(SlackParticipant) }).openapi("SlackReaction"))
  .openapi("SlackReactions");

const MessageInput = z
  .object({
    text: z.string().optional(),
    blocks: z.array(z.unknown()).optional(),
    metadata: z
      .object({ event_type: z.string(), event_payload: z.record(z.string(), z.unknown()) })
      .openapi("SlackMessageMetadata")
      .optional(),
  })
  .openapi("SlackMessageInput", { "x-channelstack-shorthand": "text" });

const participantRef = z.string().openapi(refTo("SlackUser", "SlackApp"));
const conversationRef = z.string().openapi(refTo("SlackConversation"));
const messageRef = z.object({ channel: z.string(), ts: z.string() }).openapi(refTo("SlackMessage"));

const UserParams = z.object({ user: z.string().openapi({ param: { name: "user", in: "path" } }) });
const ChannelParams = z.object({ channel: z.string().openapi({ param: { name: "channel", in: "path" } }) });
const MessageParams = ChannelParams.extend({ ts: z.string().openapi({ param: { name: "ts", in: "path" } }) });
const messageBinding = { channel: "channel", ts: "ts" };

/** The Slack driver's control API: what a test's people do, and what a test reads back. */
export function registerSlackRoutes(
  router: DriverRouter,
  deps: { world: SlackWorld; apiUrl: () => string; secret: (name: string) => string },
): void {
  const { world } = deps;
  const stability = "experimental";

  const userWire = (user: SlackUserRecord) => ({ ...user, kind: "user" as const });
  const appWire = (app: SlackAppRecord) => ({
    id: app.id,
    name: app.name,
    kind: "app" as const,
    botUserId: app.botUserId,
    botId: app.botId,
    botToken: deps.secret("botToken"),
    appToken: deps.secret("appToken"),
    signingSecret: deps.secret("signingSecret"),
    scopes: [...app.scopes],
  });
  const participantWire = (session: string, id: string) =>
    id === world.app().botUserId ? appWire(world.app()) : userWire(world.user(session, id));
  const conversationWire = ({ id, kind, name }: SlackConversationRecord) => ({ id, kind, name });
  const messageWire = (session: string, message: SlackMessageRecord) => ({
    channel: message.conversation,
    ts: message.ts,
    conversation: conversationWire(world.conversation(session, message.conversation)),
    author: participantWire(session, message.user),
    text: message.text,
    blocks: message.blocks,
    // A Slack `ts` is the time the message was posted: seconds, then a counter.
    postedAt: new Date(Number(message.ts.split(".")[0]) * 1000).toISOString(),
    threadTs: message.threadTs,
    edited: message.edited !== undefined,
    visibleTo: message.ephemeralFor === undefined ? undefined : userWire(world.user(session, message.ephemeralFor)),
    deliveries: [...message.deliveries],
    delivery: message.deliveries[0],
  });

  router.route({
    method: "get",
    path: "",
    summary: "The Slack fixture: the agent's app, the workspace, and where the agent reaches the fake",
    response: SlackFixture,
    factory: { on: "Session", name: "slack" },
    stability,
    handler: () => ({ app: appWire(world.app()), apiUrl: deps.apiUrl(), team: world.team() }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person in the workspace",
    body: z
      .object({
        name: z.string().min(1),
        id: z.string().optional(),
        displayName: z.string().optional(),
        realName: z.string().optional(),
        email: z.string().optional(),
        timezone: z.string().optional(),
        admin: z.boolean().optional(),
        owner: z.boolean().optional(),
        guest: z.boolean().optional(),
        bot: z.boolean().optional(),
      })
      .openapi("SlackUserOptions"),
    response: SlackUser,
    factory: {
      on: "SlackFixture",
      name: "createUser",
      options: ["name", "id", "displayName", "realName", "email", "timezone", "admin", "owner", "guest", "bot"],
    },
    stability,
    handler: ({ session, body }) => userWire(world.createUser(session.id, body)),
  });

  router.route({
    method: "post",
    path: "/channels",
    summary: "Create a channel. Only the listed participants are members; include the app for it to receive events",
    body: z
      .object({
        name: z.string().min(1).optional(),
        private: z.boolean().optional(),
        participants: z.array(participantRef).default([]),
        topic: z.string().optional(),
        purpose: z.string().optional(),
      })
      .openapi("SlackChannelOptions"),
    response: SlackConversation,
    errors: ["not_found", "name_taken"],
    factory: {
      on: "SlackFixture",
      name: "createChannel",
      options: ["name", "private", "participants", "topic", "purpose"],
    },
    stability,
    handler: ({ session, body }) => conversationWire(world.createChannel(session.id, body)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/say",
    summary: "Post a top-level message in a conversation, or in a DM with the people in `to`",
    params: UserParams,
    body: z
      .object({ message: MessageInput, channel: conversationRef.optional(), to: z.array(participantRef).optional() })
      .openapi("SlackSayBody"),
    response: SlackMessage,
    errors: ["not_found", "not_in_channel", "no_text", "msg_too_long"],
    sdkMethod: { on: "SlackUser", name: "say", args: ["message"], options: ["channel", "to"] },
    stability,
    handler: ({ session, params, body }) => {
      const where =
        body.channel !== undefined ? { channel: body.channel } : body.to !== undefined ? { to: body.to } : undefined;
      if (!where || (body.channel !== undefined && body.to !== undefined)) {
        throw new ProtocolError("invalid_argument", "say needs exactly one of `channel` and `to`");
      }
      return messageWire(session.id, world.postAsUser(session.id, params.user, body.message, where));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/reply",
    summary: "Reply in a thread: pass the message that starts it, or any reply in it",
    params: UserParams,
    body: z
      .object({ message: MessageInput, thread: messageRef, alsoSendToChannel: z.boolean().optional() })
      .openapi("SlackReplyBody"),
    response: SlackMessage,
    errors: ["not_found", "not_in_channel", "no_text", "msg_too_long"],
    sdkMethod: { on: "SlackUser", name: "reply", args: ["message"], options: ["thread", "alsoSendToChannel"] },
    stability,
    handler: ({ session, params, body }) =>
      messageWire(
        session.id,
        world.replyAsUser(session.id, params.user, body.message, body.thread, body.alsoSendToChannel === true),
      ),
  });

  router.route({
    method: "post",
    path: "/users/{user}/edit",
    summary: "Edit one of this person's own messages",
    params: UserParams,
    body: z.object({ text: MessageInput, message: messageRef }).openapi("SlackEditBody"),
    response: SlackMessage,
    errors: ["not_found", "not_in_channel", "cant_update_message", "no_text"],
    sdkMethod: { on: "SlackUser", name: "edit", args: ["text"], options: ["message"] },
    stability,
    handler: ({ session, params, body }) =>
      messageWire(session.id, world.editAsUser(session.id, params.user, body.text, body.message)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/delete",
    summary: "Delete a message: this person's own, or anyone's for an admin",
    params: UserParams,
    body: z.object({ message: messageRef }).openapi("SlackDeleteBody"),
    errors: ["not_found", "not_in_channel", "cant_delete_message"],
    sdkMethod: { on: "SlackUser", name: "delete", options: ["message"] },
    stability,
    handler: ({ session, params, body }) => world.deleteAsUser(session.id, params.user, body.message),
  });

  for (const [name, action] of [
    ["react", "add"],
    ["unreact", "remove"],
  ] as const) {
    router.route({
      method: "post",
      path: `/users/{user}/${name}`,
      summary:
        action === "add" ? "Add an emoji reaction to a message" : "Remove this person's emoji reaction from a message",
      params: UserParams,
      body: z
        .object({ emoji: z.string().min(1), message: messageRef })
        .openapi(action === "add" ? "SlackReactBody" : "SlackUnreactBody"),
      response: z
        .object({ delivery: z.string().optional() })
        .openapi(action === "add" ? "SlackReactResult" : "SlackUnreactResult"),
      errors: ["not_found", "not_in_channel", action === "add" ? "already_reacted" : "no_reaction"],
      sdkMethod: { on: "SlackUser", name, args: ["emoji"], options: ["message"] },
      stability,
      handler: ({ session, params, body }) => ({
        delivery: world.reactAsUser(session.id, params.user, body.emoji, body.message, action),
      }),
    });
  }

  router.route({
    method: "post",
    path: "/users/{user}/open-dm",
    summary: "Open (or reuse) a DM with the app, another person, or several",
    params: UserParams,
    body: z.object({ participants: z.array(participantRef).min(1) }).openapi("SlackOpenDmBody"),
    response: SlackConversation,
    errors: ["not_found"],
    sdkMethod: { on: "SlackUser", name: "openDM", args: ["participants"] },
    stability,
    handler: ({ session, params, body }) =>
      conversationWire(world.openConversation(session.id, params.user, body.participants)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/invite",
    summary: "Invite people or the app to a channel",
    params: UserParams,
    body: z
      .object({ participants: z.array(participantRef).min(1), channel: conversationRef })
      .openapi("SlackInviteBody"),
    errors: ["not_found", "not_in_channel", "already_in_channel"],
    sdkMethod: { on: "SlackUser", name: "invite", args: ["participants"], options: ["channel"] },
    stability,
    handler: ({ session, params, body }) => world.invite(session.id, params.user, body.participants, body.channel),
  });

  router.route({
    method: "post",
    path: "/users/{user}/kick",
    summary: "Remove someone from a channel",
    params: UserParams,
    body: z.object({ participant: participantRef, channel: conversationRef }).openapi("SlackKickBody"),
    errors: ["not_found", "not_in_channel"],
    sdkMethod: { on: "SlackUser", name: "kick", args: ["participant"], options: ["channel"] },
    stability,
    handler: ({ session, params, body }) => world.kick(session.id, params.user, body.participant, body.channel),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages",
    summary: "Top-level messages of a conversation, oldest first",
    params: ChannelParams,
    response: z.array(SlackMessage).openapi("SlackMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackConversation", name: "messages" },
    stability,
    handler: ({ session, params }) =>
      world.messages(session.id, params.channel).map((message) => messageWire(session.id, message)),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/members",
    summary: "The people and apps in a conversation",
    params: ChannelParams,
    response: z.array(SlackParticipant).openapi("SlackMembers"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackConversation", name: "members" },
    stability,
    handler: ({ session, params }) =>
      [...world.conversation(session.id, params.channel).members].map((id) => participantWire(session.id, id)),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}",
    summary: "Re-read a message: its latest text, edits and deliveries",
    params: MessageParams,
    response: SlackMessage,
    errors: ["not_found"],
    sdkMethod: { on: "SlackMessage", name: "refresh", bind: messageBinding },
    stability,
    handler: ({ session, params }) => messageWire(session.id, world.message(session.id, params.channel, params.ts)),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}/replies",
    summary: "Replies in the thread this message starts, oldest first",
    params: MessageParams,
    response: z.array(SlackMessage).openapi("SlackReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackMessage", name: "replies", bind: messageBinding },
    stability,
    handler: ({ session, params }) => {
      const root = world.message(session.id, params.channel, params.ts);
      return world
        .replies(session.id, params.channel, root.threadTs ?? root.ts)
        .map((message) => messageWire(session.id, message));
    },
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}/reactions",
    summary: "The reactions on a message, and who added each",
    params: MessageParams,
    response: SlackReactions,
    errors: ["not_found"],
    sdkMethod: { on: "SlackMessage", name: "reactions", bind: messageBinding },
    stability,
    handler: ({ session, params }) =>
      world.message(session.id, params.channel, params.ts).reactions.map((reaction) => ({
        emoji: reaction.name,
        by: reaction.users.map((id) => participantWire(session.id, id)),
      })),
  });
}
