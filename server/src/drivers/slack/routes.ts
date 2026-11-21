import { z } from "@hono/zod-openapi";

import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import { slackTsTime } from "../../core/ids/index.ts";
import type { DriverRouter } from "../../core/router/index.ts";
import { plain } from "./blocks.ts";
import type { FakeSlackWorld } from "./fake/world.ts";
import { renderTranscript } from "./transcript.ts";
import { shownValue, viewInputs } from "./views.ts";
import type {
  SlackAppRecord,
  SlackConversationRecord,
  SlackMessageRecord,
  SlackUserRecord,
  SlackViewRecord,
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

/** A thread is identified by the conversation and its root message's `ts`. A message that has no replies yet is a thread too. */
const SlackThread = z
  .object({ channel: z.string(), ts: z.string(), conversation: SlackConversation })
  .openapi("SlackThread", { "x-channelstack-resource": { id: ["channel", "ts"] } });

const SlackStream = z
  .object({
    channel: z.string(),
    ts: z.string(),
    state: z.enum(["open", "stopped", "completed"]),
    chunks: z.array(z.string()),
    startedAt: z.string(),
    endedAt: z.string().optional(),
  })
  .openapi("SlackStream", { "x-channelstack-resource": { id: ["channel", "ts"] } });

const DeliveryStatus = z.enum(["pending", "acknowledged", "failed", "timed_out", "unreachable"]);

const DeliveryAttempt = z
  .object({
    number: z.number().int(),
    sentAt: z.string(),
    transport: z.enum(["http", "socket"]),
    url: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    status: DeliveryStatus,
    responseStatus: z.number().int().optional(),
    responseBody: z.string().optional(),
    durationMs: z.number().optional(),
    forgedSignature: z.boolean(),
  })
  .openapi("DeliveryAttempt");

const SlackDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("slack"),
    type: z.string(),
    eventType: z.string().optional(),
    eventId: z.string().optional(),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("SlackDelivery", { "x-channelstack-resource": { id: "id" } });

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
    /** The thread this message starts or belongs to. */
    thread: SlackThread,
    /** The delivery this message caused to the agent; when it caused several, the `app_mention`. */
    delivery: SlackDelivery.optional(),
    stream: SlackStream.optional(),
  })
  .openapi("SlackMessage", { "x-channelstack-resource": { id: ["channel", "ts"] } });

const SlackModal = z
  .object({
    viewId: z.string(),
    user: SlackUser,
    title: z.string(),
    blocks: z.array(z.unknown()),
    errors: z
      .record(z.string(), z.string())
      .openapi({ description: "What the app said is wrong after a submission, by the label of the input." }),
  })
  .openapi("SlackModal", { "x-channelstack-resource": { id: "viewId" } });

const SlackThreadStatus = z
  .object({
    /** `working`: a status line or a processing session. `streaming`: a stream is open. `stopped`: a person pressed Stop. */
    state: z.enum(["working", "streaming", "stopped", "idle"]),
    text: z.string().optional(),
    sessionStatus: z.enum(["active", "processing", "suspended", "closed"]).optional(),
  })
  .openapi("SlackThreadStatus");

const Principal = z
  .object({ id: z.string(), name: z.string(), kind: z.enum(["user", "app"]) })
  .openapi("SlackPrincipal");

const SlackTranscript = z
  .object({
    entries: z.array(
      z
        .object({
          id: z.string(),
          author: Principal,
          at: z.string(),
          text: z.string(),
          controls: z.array(z.string()),
          files: z.array(z.string()).openapi({ description: "The names of the files shared with the message." }),
          alsoInChannel: z
            .literal(true)
            .optional()
            .openapi({ description: "A reply that was also sent to the channel." }),
          edited: z.boolean(),
          streaming: z.enum(["open", "stopped", "completed"]).optional(),
          visibleTo: Principal.optional(),
          depth: z.number().int(),
        })
        .openapi("SlackTranscriptEntry"),
    ),
    text: z.string().openapi({ description: "The transcript as plain text, one entry per line." }),
  })
  .openapi("SlackTranscript", { "x-channelstack-string": "text" });

const SlackApiCall = z
  .object({
    id: z.string(),
    channel: z.literal("slack"),
    operation: z.string(),
    method: z.string(),
    path: z.string(),
    at: z.string(),
    durationMs: z.number(),
    request: z.unknown(),
    responseStatus: z.number().int(),
    response: z.unknown(),
    error: z.string().optional(),
  })
  .openapi("SlackApiCall");

const duration = (description: string) =>
  z.number().int().min(0).openapi({ description, "x-channelstack-duration": true });

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
/** One participant or several: `ana.invite(slack.app, …)` and `ana.invite([ben, slack.app], …)` both work. */
const participants = () => z.array(participantRef).min(1).openapi({ "x-channelstack-one-or-many": true });
const conversationRef = z.string().openapi(refTo("SlackConversation"));
const messageRef = z.object({ channel: z.string(), ts: z.string() }).openapi(refTo("SlackMessage"));
const threadRef = z.object({ channel: z.string(), ts: z.string() }).openapi(refTo("SlackThread", "SlackMessage"));

const UserParams = z.object({ user: z.string().openapi({ param: { name: "user", in: "path" } }) });
const ChannelParams = z.object({ channel: z.string().openapi({ param: { name: "channel", in: "path" } }) });
const MessageParams = ChannelParams.extend({ ts: z.string().openapi({ param: { name: "ts", in: "path" } }) });
const messageBinding = { channel: "channel", ts: "ts" };

/** The Slack driver's control API: what a test's people do, and what a test reads back. */
export function registerSlackRoutes(
  router: DriverRouter,
  deps: { world: FakeSlackWorld; events: EventLog; apiUrl: () => string; secret: (name: string) => string },
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
    postedAt: slackTsTime(message.ts),
    threadTs: message.threadTs,
    edited: message.edited !== undefined,
    visibleTo: message.ephemeralFor === undefined ? undefined : userWire(world.user(session, message.ephemeralFor)),
    thread: {
      channel: message.conversation,
      ts: message.threadTs ?? message.ts,
      conversation: conversationWire(world.conversation(session, message.conversation)),
    },
    delivery:
      message.deliveries[0] === undefined ? undefined : deliveryWire(world.delivery(session, message.deliveries[0])),
    stream:
      message.stream === undefined
        ? undefined
        : {
            channel: message.conversation,
            ts: message.ts,
            state: message.stream.state,
            chunks: [...message.stream.chunks],
            startedAt: new Date(message.stream.startedAt).toISOString(),
            endedAt: message.stream.endedAt === undefined ? undefined : new Date(message.stream.endedAt).toISOString(),
          },
  });

  const deliveryWire = ({ request, attempts }: DeliveryRecord) => {
    const meta = request.meta ?? {};
    return {
      id: request.id,
      channel: "slack" as const,
      type: request.type,
      eventType: typeof meta.eventType === "string" ? meta.eventType : undefined,
      eventId: request.type === "event_callback" ? request.id : undefined,
      payload: meta.payload,
      attempts,
      status: attempts.at(-1)?.status ?? ("pending" as const),
    };
  };

  const principal = (session: string) => (id: string) => {
    const { id: principalId, name, kind } = participantWire(session, id);
    return { id: principalId, name, kind };
  };
  /** The name a mention shows as, or nothing for an id that is nobody this session knows. */
  const mentionName = (session: string) => (id: string) => {
    try {
      return participantWire(session, id).name;
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "not_found") return undefined;
      throw error;
    }
  };

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
    method: "get",
    path: "/users",
    summary: "The people this session created",
    response: z.array(SlackUser).openapi("SlackUsers"),
    sdkMethod: { on: "SlackFixture", name: "users" },
    stability: "experimental",
    handler: ({ session }) => world.users(session.id).map(userWire),
  });

  router.route({
    method: "get",
    path: "/conversations",
    summary: "The session's conversations, the one with the newest message last",
    response: z.array(SlackConversation).openapi("SlackConversations"),
    sdkMethod: { on: "SlackFixture", name: "conversations" },
    stability: "experimental",
    handler: ({ session }) => world.conversations(session.id).map(conversationWire),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/latest",
    summary: "The newest message of a conversation, replies included",
    params: ChannelParams,
    response: SlackMessage,
    errors: ["not_found"],
    sdkMethod: { on: "SlackConversation", name: "latestMessage" },
    stability: "experimental",
    handler: ({ session, params }) => {
      const latest = world
        .everything(session.id, params.channel)
        .filter((message) => message.ephemeralFor === undefined)
        .at(-1);
      if (!latest) throw new ProtocolError("not_found", "The conversation has no messages yet");
      return messageWire(session.id, latest);
    },
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
      .object({ message: MessageInput, channel: conversationRef.optional(), to: participants().optional() })
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
      .object({ message: MessageInput, thread: threadRef, alsoSendToChannel: z.boolean().optional() })
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

  const controlRef = (name: string) =>
    z
      .object({ label: z.string().optional(), actionId: z.string().optional() })
      .openapi(name, { "x-channelstack-shorthand": "label" });
  /** The delivery an interaction caused, for the routes that answer with it. */
  const interaction = (session: string, delivery: string) => deliveryWire(world.delivery(session, delivery));

  router.route({
    method: "post",
    path: "/users/{user}/click",
    summary:
      "Click a button, found by its label or action_id: on a message, or on the app's latest message that has it in a thread or a conversation",
    params: UserParams,
    body: z
      .object({
        button: z
          .object({ label: z.string().optional(), actionId: z.string().optional(), value: z.string().optional() })
          .openapi("SlackButtonRef", { "x-channelstack-shorthand": "label" }),
        message: messageRef.optional(),
        thread: threadRef.optional(),
        channel: conversationRef.optional(),
      })
      .openapi("SlackClickBody"),
    response: SlackDelivery,
    errors: ["not_found", "not_in_channel", "dispatch_failed"],
    sdkMethod: { on: "SlackUser", name: "click", args: ["button"], options: ["message", "thread", "channel"] },
    stability,
    handler: ({ session, params, body }) => {
      const scopes = [
        body.message && { message: body.message },
        body.thread && { thread: body.thread },
        body.channel !== undefined && { channel: body.channel },
      ].filter((scope) => scope !== undefined && scope !== false);
      const [where] = scopes;
      if (scopes.length !== 1 || !where) {
        throw new ProtocolError("invalid_argument", "click needs exactly one of `message`, `thread` and `channel`");
      }
      if (body.button.label === undefined && body.button.actionId === undefined) {
        throw new ProtocolError("invalid_argument", "Say which button: its label or its action_id");
      }
      return interaction(session.id, world.clickAsUser(session.id, params.user, body.button, where));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/select",
    summary:
      "Choose from a select menu on a message: options by their text or value, the menu by its placeholder or action_id",
    params: UserParams,
    body: z
      .object({
        option: z.array(z.string()).min(1).openapi({ "x-channelstack-one-or-many": true }),
        menu: controlRef("SlackMenuRef"),
        message: messageRef,
      })
      .openapi("SlackSelectBody"),
    response: SlackDelivery,
    errors: ["not_found", "not_in_channel", "dispatch_failed"],
    sdkMethod: { on: "SlackUser", name: "select", args: ["option"], options: ["menu", "message"] },
    stability,
    handler: ({ session, params, body }) =>
      interaction(session.id, world.selectAsUser(session.id, params.user, body.option, body.menu, body.message)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/shortcut",
    summary: "Run a message shortcut on a message",
    params: UserParams,
    body: z.object({ callbackId: z.string().min(1), message: messageRef }).openapi("SlackShortcutBody"),
    response: SlackDelivery,
    errors: ["not_found", "not_in_channel", "dispatch_failed"],
    sdkMethod: { on: "SlackUser", name: "shortcut", args: ["callbackId"], options: ["message"] },
    stability,
    handler: ({ session, params, body }) =>
      interaction(session.id, world.shortcutAsUser(session.id, params.user, body.callbackId, body.message)),
  });

  router.route({
    method: "post",
    path: "/users/{user}/commands",
    summary: "Run a slash command in a conversation, e.g. `/deploy web staging`",
    params: UserParams,
    body: z.object({ command: z.string().regex(/^\/\S/), channel: conversationRef }).openapi("SlackCommandBody"),
    response: SlackDelivery,
    errors: ["not_found", "not_in_channel", "dispatch_failed"],
    sdkMethod: { on: "SlackUser", name: "runCommand", args: ["command"], options: ["channel"] },
    stability,
    handler: ({ session, params, body }) =>
      interaction(session.id, world.commandAsUser(session.id, params.user, body.command, body.channel)),
  });

  const ViewParams = z.object({ view: z.string().openapi({ param: { name: "view", in: "path" } }) });
  const modalWire = (session: string, view: SlackViewRecord) => {
    const inputs = viewInputs(view.definition.blocks);
    return {
      viewId: view.id,
      user: userWire(world.user(session, view.user)),
      title: plain(view.definition.title),
      blocks: view.definition.blocks,
      // What the app said is wrong, by the label of the input it is shown at.
      errors: Object.fromEntries(
        Object.entries(view.errors).map(([block, message]) => [
          inputs.find((input) => input.blockId === block)?.label ?? block,
          message,
        ]),
      ),
    };
  };

  router.route({
    method: "get",
    path: "/users/{user}/modals",
    summary: "The modals the app has open for this person, the one on top last",
    params: UserParams,
    response: z.array(SlackModal).openapi("SlackModals"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackUser", name: "modals" },
    waits: [{ name: "waitForModal", mode: "next", text: "title", what: "a modal from the agent" }],
    stability,
    handler: ({ session, params }) => world.modals(session.id, params.user).map((view) => modalWire(session.id, view)),
  });

  router.route({
    method: "get",
    path: "/modals/{view}/values",
    summary: "What is filled in: each input by its label (or action_id), with the text a person sees in it",
    params: ViewParams,
    response: z.record(z.string(), z.union([z.string(), z.array(z.string())]).optional()).openapi("SlackModalValues"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackModal", name: "values" },
    stability,
    handler: ({ session, params }) => {
      const view = world.modal(session.id, params.view);
      return Object.fromEntries(
        viewInputs(view.definition.blocks).map((input) => [
          input.label || input.actionId,
          shownValue(view.values[input.blockId]?.[input.actionId] ?? { type: "" }),
        ]),
      );
    },
  });

  router.route({
    method: "post",
    path: "/modals/{view}/submit",
    summary: "Fill in inputs, by label or `block_id.action_id`, and submit the modal",
    params: ViewParams,
    body: z
      .object({ values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional() })
      .openapi("SlackModalSubmitBody"),
    response: SlackDelivery,
    errors: ["not_found", "dispatch_failed"],
    sdkMethod: { on: "SlackModal", name: "submit", args: ["values"] },
    stability,
    handler: ({ session, params, body }) =>
      interaction(session.id, world.submitModal(session.id, params.view, body.values ?? {})),
  });

  router.route({
    method: "post",
    path: "/modals/{view}/close",
    summary: "Close the modal. The app is told only if it asked to be (`notify_on_close`)",
    params: ViewParams,
    response: SlackDelivery.nullable(),
    errors: ["not_found", "dispatch_failed"],
    sdkMethod: { on: "SlackModal", name: "close" },
    stability,
    handler: ({ session, params }) => {
      const delivery = world.closeModal(session.id, params.view);
      return delivery === undefined ? null : interaction(session.id, delivery);
    },
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
      // The delivery the reaction caused, or nothing when the app isn't told (not subscribed, not a member).
      response: SlackDelivery.nullable(),
      errors: ["not_found", "not_in_channel", action === "add" ? "already_reacted" : "no_reaction"],
      sdkMethod: { on: "SlackUser", name, args: ["emoji"], options: ["message"] },
      stability,
      handler: ({ session, params, body }) => {
        const delivery = world.reactAsUser(session.id, params.user, body.emoji, body.message, action);
        return delivery === undefined ? null : deliveryWire(world.delivery(session.id, delivery));
      },
    });
  }

  router.route({
    method: "post",
    path: "/users/{user}/open-dm",
    summary: "Open (or reuse) a DM with the app, another person, or several",
    params: UserParams,
    body: z.object({ participants: participants() }).openapi("SlackOpenDmBody"),
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
    body: z.object({ participants: participants(), channel: conversationRef }).openapi("SlackInviteBody"),
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
    waits: [{ name: "waitForMessage", mode: "next", from: "author", what: "a message" }],
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
    path: "/conversations/{channel}/threads/{ts}/replies",
    summary: "Replies in a thread, oldest first, without the message that starts it",
    params: MessageParams,
    response: z.array(SlackMessage).openapi("SlackReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackThread", name: "replies", bind: messageBinding },
    waits: [
      { name: "waitForReply", mode: "next", from: "author", what: "a reply" },
      { name: "latestReply", mode: "latest", from: "author", what: "a reply" },
    ],
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

  router.route({
    method: "get",
    path: "/conversations/{channel}/threads/{ts}/state",
    summary: "What the agent is doing in a thread: its status line, an open stream, or idle",
    params: MessageParams,
    response: SlackThreadStatus,
    errors: ["not_found"],
    sdkMethod: { on: "SlackThread", name: "status", bind: messageBinding },
    stability,
    handler: ({ session, params }) => {
      const state = world.threadState(session.id, params.channel, params.ts);
      const streams = world.thread(session.id, params.channel, params.ts).flatMap((message) => message.stream ?? []);
      const working = state.statusText !== "" || state.sessionStatus === "processing";
      return {
        state: streams.some((stream) => stream.state === "open")
          ? ("streaming" as const)
          : working
            ? ("working" as const)
            : streams.at(-1)?.state === "stopped"
              ? ("stopped" as const)
              : ("idle" as const),
        text: state.statusText === "" ? undefined : state.statusText,
        sessionStatus: state.sessionStatus,
      };
    },
  });

  /** Who is reading: ephemeral messages show only to their recipient. */
  const viewer = z
    .string()
    .optional()
    .openapi({ param: { name: "as", in: "query" }, "x-channelstack-ref": ["SlackUser", "SlackApp"] });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}/transcript",
    summary: "A message and the replies under it as a person would read them",
    params: MessageParams,
    query: z.object({ as: viewer }),
    response: SlackTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "SlackMessage", name: "transcript", options: ["as"], bind: messageBinding },
    stability,
    handler: ({ session, params, query }) =>
      renderTranscript(world.thread(session.id, params.channel, params.ts), {
        viewer: query.as,
        principal: principal(session.id),
        mentionName: mentionName(session.id),
      }),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/threads/{ts}/transcript",
    summary: "A thread as a person would read it",
    params: MessageParams,
    query: z.object({
      as: viewer,
    }),
    response: SlackTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "SlackThread", name: "transcript", options: ["as"], bind: messageBinding },
    stability,
    handler: ({ session, params, query }) =>
      renderTranscript(world.thread(session.id, params.channel, params.ts), {
        viewer: query.as,
        principal: principal(session.id),
        mentionName: mentionName(session.id),
      }),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/transcript",
    summary: "The conversation as a person would read it, threads included",
    params: ChannelParams,
    query: z.object({
      as: viewer,
    }),
    response: SlackTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "SlackConversation", name: "transcript", options: ["as"] },
    stability,
    handler: ({ session, params, query }) =>
      renderTranscript(world.everything(session.id, params.channel), {
        viewer: query.as,
        principal: principal(session.id),
        mentionName: mentionName(session.id),
      }),
  });

  router.route({
    method: "get",
    path: "/users/{user}/ephemeral",
    summary: "Messages only this person can see",
    params: UserParams,
    response: z.array(SlackMessage).openapi("SlackEphemeralMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackUser", name: "ephemeral" },
    stability,
    handler: ({ session, params }) =>
      world.ephemeral(session.id, params.user).map((message) => messageWire(session.id, message)),
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}/stream",
    summary: "Re-read a streamed message's stream: its state and what was streamed so far",
    params: MessageParams,
    response: SlackStream,
    errors: ["not_found"],
    sdkMethod: { on: "SlackStream", name: "refresh", bind: messageBinding },
    waits: [{ name: "ended", mode: "until", field: "state", not: ["open"], what: "the stream to end" }],
    stability,
    handler: ({ session, params }) => {
      const { stream } = messageWire(session.id, world.message(session.id, params.channel, params.ts));
      if (!stream) throw new ProtocolError("not_found", `Message ${params.ts} isn't a stream`, { ts: params.ts });
      return stream;
    },
  });

  router.route({
    method: "get",
    path: "/conversations/{channel}/messages/{ts}/deliveries",
    summary: "Every delivery this message caused to the agent",
    params: MessageParams,
    response: z.array(SlackDelivery).openapi("SlackMessageDeliveries"),
    errors: ["not_found"],
    sdkMethod: { on: "SlackMessage", name: "deliveries", bind: messageBinding },
    stability,
    handler: ({ session, params }) =>
      world
        .message(session.id, params.channel, params.ts)
        .deliveries.map((id) => deliveryWire(world.delivery(session.id, id))),
  });

  const DeliveryParams = z.object({ delivery: z.string().openapi({ param: { name: "delivery", in: "path" } }) });

  router.route({
    method: "get",
    path: "/deliveries",
    summary: "Every event channelstack sent the agent for this session, with every attempt",
    response: z.array(SlackDelivery).openapi("SlackDeliveries"),
    sdkMethod: { on: "SlackFixture", name: "deliveries" },
    stability,
    handler: ({ session }) => world.deliveries(session.id).map(deliveryWire),
  });

  router.route({
    method: "get",
    path: "/deliveries/{delivery}",
    summary: "Re-read a delivery: its attempts and status",
    params: DeliveryParams,
    response: SlackDelivery,
    errors: ["not_found"],
    sdkMethod: { on: "SlackDelivery", name: "refresh" },
    waits: [{ name: "settled", mode: "until", field: "status", not: ["pending"], what: "the delivery to settle" }],
    stability,
    handler: ({ session, params }) => deliveryWire(world.delivery(session.id, params.delivery)),
  });

  router.route({
    method: "post",
    path: "/deliveries/{delivery}/retry",
    summary: "Retry the way Slack does: the same payload, with X-Slack-Retry-Num and X-Slack-Retry-Reason",
    params: DeliveryParams,
    body: z
      .object({
        after: duration("How long to wait before the retry. Slack's first retry comes after about 3 seconds.").default(
          3000,
        ),
        reason: z.enum(["http_timeout", "http_error", "too_many_redirects"]).default("http_timeout"),
      })
      .openapi("SlackRetryBody"),
    response: DeliveryAttempt,
    errors: ["not_found"],
    sdkMethod: { on: "SlackDelivery", name: "retry", options: ["after", "reason"] },
    stability,
    handler: ({ session, params, body }) =>
      world.retry(session.id, params.delivery, { afterMs: body.after, reason: body.reason }),
  });

  router.route({
    method: "post",
    path: "/deliveries/{delivery}/resend",
    summary:
      "Send the delivery again, unchanged or forged: a wrong signature, or a timestamp outside the replay window",
    params: DeliveryParams,
    body: z
      .object({
        badSignature: z.boolean().default(false),
        stale: z.boolean().default(false),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .openapi("SlackResendBody"),
    response: DeliveryAttempt,
    errors: ["not_found"],
    sdkMethod: { on: "SlackDelivery", name: "resend", options: ["badSignature", "stale", "headers"] },
    stability,
    handler: ({ session, params, body }) => world.resend(session.id, params.delivery, body),
  });

  router.route({
    method: "get",
    path: "/calls",
    summary:
      "The Web API calls the agent made about this session's conversations, people and files. Calls about nothing a session owns (auth.test, users.list) are in no session",
    query: z.object({
      operation: z
        .string()
        .optional()
        .openapi({ param: { name: "operation", in: "query" } }),
      // In the query it is text either way; the union is what the SDKs accept: `true` or a code.
      error: z
        .union([z.literal(true), z.string()])
        .optional()
        .openapi({ param: { name: "error", in: "query" }, description: "`true` for any error, or one error code" }),
    }),
    response: z.array(SlackApiCall).openapi("SlackApiCalls"),
    sdkMethod: { on: "SlackFixture", name: "calls", options: ["operation", "error"] },
    waits: [{ name: "waitForCall", mode: "next", filter: true, what: "an API call from the agent" }],
    stability,
    handler: ({ session, query }) =>
      deps.events
        .read(session.id)
        .events.map((event, index) => ({ event, id: `call_${index + 1}` }))
        .filter(({ event }) => event.kind === "api_call" && event.driver === "slack")
        .map(({ event, id }) => ({
          ...(event.data as z.infer<typeof SlackApiCall>),
          id,
          channel: "slack" as const,
          at: event.at,
        }))
        .filter((call) => query.operation === undefined || call.operation === query.operation)
        .filter(
          (call) =>
            query.error === undefined ||
            (query.error === "true" ? call.error !== undefined : call.error === query.error),
        ),
  });

  router.route({
    method: "post",
    path: "/uninstall",
    summary: "The workspace uninstalls the app. Undone when this session closes; run such tests on their own",
    response: z.array(SlackDelivery).openapi("SlackUninstallDeliveries"),
    errors: ["account_inactive"],
    sdkMethod: { on: "SlackFixture", name: "uninstallApp" },
    stability,
    handler: ({ session }) => world.uninstallApp(session.id).map((id) => deliveryWire(world.delivery(session.id, id))),
  });

  router.route({
    method: "post",
    path: "/faults",
    summary: "Inject a transport fault into the agent's Web API calls. Removed when this session closes",
    body: z
      .object({
        type: z.enum(["rate_limit", "latency", "error"]),
        operation: z.string().optional(),
        retryAfter: duration("For rate_limit: what Retry-After says.").default(1000),
        delay: duration("For latency: how long each call takes longer.").default(0),
        error: z.string().default("internal_error"),
        times: z.number().int().min(1).optional(),
      })
      .openapi("SlackFaultBody"),
    response: z.object({ id: z.string() }).openapi("SlackFault", { "x-channelstack-resource": { id: "id" } }),
    sdkMethod: {
      on: "SlackFixture",
      name: "fault",
      options: ["type", "operation", "retryAfter", "delay", "error", "times"],
    },
    stability,
    handler: ({ session, body }) => ({
      id: world.addFault(session.id, {
        type: body.type,
        operation: body.operation,
        remaining: body.times,
        retryAfterMs: body.retryAfter,
        delayMs: body.delay,
        error: body.error,
      }),
    }),
  });

  router.route({
    method: "delete",
    path: "/faults/{fault}",
    summary: "Remove a fault",
    params: z.object({ fault: z.string().openapi({ param: { name: "fault", in: "path" } }) }),
    sdkMethod: { on: "SlackFault", name: "undo", dispose: true },
    stability,
    handler: ({ session, params }) => world.removeFault(session.id, params.fault),
  });
}
