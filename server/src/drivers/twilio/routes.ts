import { z } from "@hono/zod-openapi";

import { iso } from "../../core/clock/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../../core/reality/index.ts";
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
  principalSchema,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import type { TwilioWorld } from "./backend.ts";
import type { FakeTwilioWorld } from "./fake/world.ts";
import { TWILIO_API } from "./live/client.ts";
import { renderConversation } from "./transcript.ts";
import type { TwilioMessageRecord, TwilioPersonRecord } from "./world.ts";

const channel = z.literal("twilio");

const TwilioPrincipal = principalSchema("TwilioPrincipal");

const TwilioUser = z
  .object({
    id: z.string().openapi({ description: "The person's number: a person on Twilio is their phone." }),
    channel,
    kind: z.literal("user"),
    name: z.string(),
    number: z.string().openapi({ description: "Their number, in E.164." }),
  })
  .openapi("TwilioUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const TwilioApp = z
  .object({
    id: z.string().openapi({ description: "The SID of the agent's number (`PN…`)." }),
    channel,
    kind: z.literal("app"),
    name: z.string(),
    botUserId: z.string(),
    number: z.string().openapi({ description: "Where people text the agent: its Twilio number, in E.164." }),
  })
  .openapi("TwilioApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const TwilioConversation = z
  .object({
    id: z.string().openapi({ description: "The SID of the first message between the two numbers." }),
    channel,
    numbers: z.array(z.string()).openapi({ description: "Its two numbers." }),
  })
  .openapi("TwilioConversation", { "x-channelstack-resource": { id: "id", role: "resource" } });

const TwilioDelivery = z
  .object({
    id: z.string().openapi({ description: "The request's `I-Twilio-Idempotency-Token`: the same on each retry." }),
    channel,
    type: z.string().openapi({ description: "`message`: a text to the agent's number; `status`: a status callback." }),
    message: z.string().openapi({ description: "The SID of the message it is about." }),
    payload: z.record(z.string(), z.string()).openapi({ description: "The form's parameters, as Twilio posted them." }),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("TwilioDelivery", { "x-channelstack-resource": { id: "id" } });

const MessageStatus = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "received",
  "canceled",
]);

const TwilioMessage = z
  .object({
    id: z.string().openapi({ description: "Its SID (`SM…`)." }),
    channel,
    conversation: TwilioConversation,
    author: TwilioPrincipal,
    from: z.string(),
    to: z.string(),
    text: z.string().openapi({ description: "What was sent." }),
    segments: z.number().int().openapi({ description: "How many SMS segments it was sent in, as Twilio counts them." }),
    status: MessageStatus,
    errorCode: z
      .number()
      .int()
      .optional()
      .openapi({ description: "Why it wasn't delivered: 30003, an unreachable phone." }),
    at: z.string(),
    delivery: TwilioDelivery.optional().openapi({ description: "For a text to the agent: the webhook that told it." }),
  })
  .openapi("TwilioMessage", { "x-channelstack-resource": { id: "id" } });

const TwilioFixture = z
  .object({
    app: TwilioApp,
    apiUrl: z
      .string()
      .openapi({ description: "Where the agent's `twilio` client sends `https://api.twilio.com`: `TWILIO_API_URL`." }),
  })
  .openapi("TwilioFixture", { "x-channelstack-resource": {} });

const TwilioTranscript = transcriptSchema("Twilio", TwilioPrincipal);
const TwilioApiCall = apiCallSchema("twilio", "TwilioApiCall");

const UserParams = z.object({ user: pathParam("user") });
const MessageParams = z.object({ message: pathParam("message") });
const ConversationParams = z.object({ conversation: pathParam("conversation") });

/** What only the agent's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Twilio doesn't report the account's API calls to anyone else; proxy mode sees them",
};
const NO_REDELIVERY: LiveSupport = { unsupported: "Twilio has no API to send a webhook again" };

/** The Twilio driver's control API: what a test's people do, and what a test reads back. */
export function registerTwilioRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeTwilioWorld;
    live: TwilioWorld | undefined;
    world: TwilioWorld;
    events: EventLog;
    apiUrl: () => string;
  },
): void {
  const { fake, world } = deps;
  const { store } = world;
  const stability = "experimental";

  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "twilio" as const,
    type: request.type,
    message: String(request.meta?.message ?? ""),
    payload: (request.meta?.payload ?? {}) as Record<string, string>,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const appWire = () => ({
    id: store.app.id,
    channel: "twilio" as const,
    kind: "app" as const,
    name: store.app.name,
    botUserId: store.app.id,
    number: store.app.number,
  });
  const userWire = (user: TwilioPersonRecord) => ({
    id: user.id,
    channel: "twilio" as const,
    kind: "user" as const,
    name: user.name,
    number: user.number,
  });
  const conversationWire = (id: string) => ({
    id,
    channel: "twilio" as const,
    numbers: [...(store.conversations.find(id)?.numbers ?? [])],
  });
  const messageWire = (session: string, message: TwilioMessageRecord) => ({
    id: message.id,
    channel: "twilio" as const,
    conversation: conversationWire(message.conversation),
    author: world.principalOf(message),
    from: message.from,
    to: message.to,
    text: message.body,
    segments: message.segments,
    status: message.status,
    ...(message.errorCode === undefined ? {} : { errorCode: message.errorCode }),
    at: iso(message.createdAt),
    ...(deps.live || message.delivery === undefined
      ? {}
      : { delivery: deliveryWire(fake.delivery(session, message.delivery) as DeliveryRecord) }),
  });

  const person = (session: string, id: string) => store.users.get(session, id);
  const messageOf = (session: string, id: string) => {
    const message = store.messages.find(id);
    // A session reads its own messages, and those of conversations it owns (the agent's answers in them).
    const owner = message === undefined ? undefined : store.messages.owner(message.id);
    if (!message || (owner !== session && store.conversations.owner(message.conversation) !== session)) {
      throw new ProtocolError("not_found", `No twilio message "${id}" in this session`, { id });
    }
    return message;
  };
  /** Whom a person texts: the app or a person, by their handle. */
  const numberOf = (session: string, id: string) =>
    id === store.app.id ? store.app.number : person(session, id).number;

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: "The Twilio fixture: the agent's account and number, and where the agent reaches the fake",
    response: TwilioFixture,
    factory: { on: "Session", name: "twilio" },
    stability,
    handler: () => ({ app: appWire(), apiUrl: deps.live ? TWILIO_API : deps.apiUrl() }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person: a phone, with a number the fake hands out unless a test gives one",
    body: z
      .object({
        name: z.string().min(1),
        number: z.string().optional().openapi({
          description:
            "Their number, in E.164. Live, one of the account's numbers; left out, the account's one allowlisted number besides the agent's. Read from CHANNELSTACK_TWILIO_USER_<NAME>_NUMBER when left out.",
          "x-channelstack-credential": "CHANNELSTACK_TWILIO_USER_{name}_NUMBER",
        }),
        reachable: z.boolean().optional().openapi({
          description: "False for a phone that's off: what the agent sends them ends `undelivered` (30003). Fake only.",
        }),
        token: z.string().min(1).optional().openapi({
          description:
            "Live: `<Account SID>:<Auth Token>` of the account that owns the person's number. Read from CHANNELSTACK_TWILIO_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_TWILIO_USER_{name}_TOKEN",
        }),
      })
      .openapi("TwilioUserOptions"),
    response: TwilioUser,
    errors: ["invalid_argument"],
    factory: { on: "TwilioFixture", name: "createUser", options: ["name", "number", "reachable", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  // --- What people do -------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/text",
    summary: "The person texts someone: the agent's number (`twilio.app`), or another person",
    params: UserParams,
    body: z
      .object({
        body: z.string().openapi({ description: "What they write." }),
        to: z
          .string()
          .openapi({ ...refTo("TwilioUser", "TwilioApp"), description: "Whom they text: the app, or a person." }),
        media: z
          .array(z.string())
          .default([])
          .openapi({ description: "The URLs of pictures they send with it (MMS)." }),
      })
      .openapi("TwilioTextBody"),
    response: TwilioMessage,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "TwilioUser", name: "text", args: ["body"], options: ["to", "media"] },
    stability,
    handler: async ({ session, params, body }) => {
      if (body.body === "" && body.media.length === 0)
        throw new ProtocolError("invalid_argument", "A text needs a body or media");
      const message = await world.text(session.id, person(session.id, params.user), {
        to: numberOf(session.id, body.to),
        body: body.body,
        media: body.media,
      });
      return messageWire(session.id, message);
    },
  });

  router.route({
    method: "get",
    path: "/users/{user}/messages",
    summary: "What reached the person's phone, oldest first",
    params: UserParams,
    response: z.array(TwilioMessage).openapi("TwilioInbox"),
    errors: ["not_found"],
    sdkMethod: { on: "TwilioUser", name: "messages" },
    waits: [{ name: "waitForMessage", mode: "next", from: "author", what: "a text" }],
    stability,
    handler: async ({ session, params }) => {
      const user = person(session.id, params.user);
      return (await world.inbox(session.id, user)).map((message) => messageWire(session.id, message));
    },
  });

  // --- What a test reads ----------------------------------------------------------------------

  router.route({
    method: "get",
    path: "/messages/{message}",
    summary: "Re-read a message: its status, once Twilio sent it",
    params: MessageParams,
    response: TwilioMessage,
    errors: ["not_found"],
    sdkMethod: { on: "TwilioMessage", name: "refresh" },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id);
      return messageWire(session.id, messageOf(session.id, params.message));
    },
  });

  const messagesIn = async (session: string, conversation: string) => {
    await world.refresh(session);
    return store.messagesIn(store.conversations.get(session, conversation).id);
  };

  router.route({
    method: "get",
    path: "/conversations/{conversation}/messages",
    summary: "Every message between the two numbers, oldest first",
    params: ConversationParams,
    response: z.array(TwilioMessage).openapi("TwilioMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "TwilioConversation", name: "messages" },
    stability,
    handler: async ({ session, params }) =>
      (await messagesIn(session.id, params.conversation)).map((message) => messageWire(session.id, message)),
  });

  router.route({
    method: "get",
    path: "/conversations/{conversation}/replies",
    summary: "The conversation's answers: every message after the first, oldest first",
    params: ConversationParams,
    response: z.array(TwilioMessage).openapi("TwilioReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "TwilioConversation", name: "replies" },
    waits: [
      { name: "waitForReply", mode: "next", from: "author", what: "a reply" },
      { name: "latestReply", mode: "latest", from: "author", what: "a reply" },
    ],
    stability,
    handler: async ({ session, params }) =>
      (await messagesIn(session.id, params.conversation)).slice(1).map((message) => messageWire(session.id, message)),
  });

  router.route({
    method: "get",
    path: "/conversations/{conversation}/transcript",
    summary: "The conversation as a person reads it on their phone",
    params: ConversationParams,
    response: TwilioTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "TwilioConversation", name: "transcript" },
    stability,
    handler: async ({ session, params }) =>
      renderConversation(await messagesIn(session.id, params.conversation), world.principalOf),
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Twilio",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: TwilioDelivery, wire: deliveryWire },
    listSummary: "Every webhook and status callback channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this kind: `message` (a text to the agent) or `status` (a status callback).",
      resource: {
        description: "Only deliveries about this conversation.",
        ref: "TwilioConversation",
        matches: ({ request }, conversation) => request.meta?.conversation === conversation,
      },
    },
    live: { reads: DELIVERY_IS_THE_PLATFORMS, redeliver: NO_REDELIVERY },
    redeliver: {
      summary:
        "Send the webhook again, as Twilio retries one: the same request and `I-Twilio-Idempotency-Token`, its TwiML acted on",
    },
    resend: {
      summary: "Send the webhook again, forged: signed with an Auth Token that isn't the account's",
      options: ["badSignature"],
    },
    calls: {
      schema: TwilioApiCall,
      summary:
        "The REST calls the agent made about this session's messages, by the SDK's method name (`messages.create`)",
      live: AGENT_SIDE,
    },
  });
}
