import { z } from "@hono/zod-openapi";

import { iso } from "../../core/clock/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { threadTranscript } from "../../core/email/index.ts";
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
import type { ResendWorld } from "./backend.ts";
import type { FakeResendWorld } from "./fake/world.ts";
import type { ResendEmailRecord, ResendUserRecord } from "./world.ts";

const ResendPrincipal = principalSchema("ResendPrincipal");

const ResendUser = z
  .object({
    id: z.string().openapi({ description: "The person's address: an email person is their mailbox." }),
    channel: z.literal("resend"),
    kind: z.literal("user"),
    name: z.string(),
    address: z.string(),
  })
  .openapi("ResendUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const ResendApp = z
  .object({
    id: z.string(),
    channel: z.literal("resend"),
    kind: z.literal("app"),
    name: z.string(),
    botUserId: z.string(),
    address: z.string().openapi({ description: "Where people email the agent: its team's receiving address." }),
  })
  .openapi("ResendApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const ResendThread = z
  .object({
    id: z.string().openapi({ description: "The id of the thread's first email." }),
    channel: z.literal("resend"),
    subject: z.string(),
  })
  .openapi("ResendThread", { "x-channelstack-resource": { id: "id", role: "resource" } });

const ResendDelivery = z
  .object({
    id: z.string().openapi({ description: "The webhook message's id (`svix-id`)." }),
    channel: z.literal("resend"),
    type: z.string().openapi({ description: "`email.received`, `email.sent`, `email.delivered`, `email.bounced`, …" }),
    email: z.string().openapi({ description: "The email the event is about." }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("ResendDelivery", { "x-channelstack-resource": { id: "id" } });

const ResendEmail = z
  .object({
    id: z.string(),
    channel: z.literal("resend"),
    thread: ResendThread,
    author: ResendPrincipal,
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    subject: z.string(),
    text: z.string().openapi({ description: "What its writer wrote, without the quoted history a reply carries." }),
    at: z.string(),
    messageId: z.string(),
    delivery: ResendDelivery.optional().openapi({
      description: "The `email.received` webhook that told the agent, for an email to it.",
    }),
  })
  .openapi("ResendEmail", { "x-channelstack-resource": { id: "id" } });

const ResendFixture = z
  .object({
    app: ResendApp,
    apiUrl: z.string().openapi({ description: "The base URL to give the agent: `RESEND_BASE_URL`." }),
  })
  .openapi("ResendFixture", { "x-channelstack-resource": {} });

const ResendTranscript = transcriptSchema("Resend", ResendPrincipal);
const ResendApiCall = apiCallSchema("resend", "ResendApiCall");

const UserParams = z.object({ user: pathParam("user") });
const EmailParams = z.object({ email: pathParam("email") });
const ThreadParams = z.object({ thread: pathParam("thread") });

const recipients = (description: string) =>
  z.array(z.string().openapi(refTo("ResendUser", "ResendApp"))).openapi({ description });

/** What only the agent's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Resend doesn't report the team's calls; proxy mode sees them",
};
/** Resend replays a webhook only from its dashboard. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Resend has no API to redeliver a webhook" };

/** The Resend driver's control API: what a test's people do, and what a test reads back. */
export function registerResendRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeResendWorld;
    live: ResendWorld | undefined;
    world: ResendWorld;
    events: EventLog;
    apiUrl: () => string;
  },
): void {
  const { fake, world } = deps;
  const { store } = world;
  const stability = "experimental";

  const appWire = () => ({
    id: store.app.id,
    channel: "resend" as const,
    kind: "app" as const,
    name: store.app.name,
    botUserId: store.app.id,
    address: store.app.address,
  });
  const userWire = (user: ResendUserRecord) => ({
    id: user.id,
    channel: "resend" as const,
    kind: "user" as const,
    name: user.name,
    address: user.address,
  });
  const threadWire = (thread: string) => ({
    id: thread,
    channel: "resend" as const,
    subject: store.threads.find(thread)?.subject ?? "",
  });
  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "resend" as const,
    type: request.type,
    email: String(request.meta?.email ?? ""),
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const emailWire = (session: string, email: ResendEmailRecord) => {
    const transcript = threadTranscript([messageOf(email)]);
    return {
      id: email.id,
      channel: "resend" as const,
      thread: threadWire(email.thread),
      author: world.principalOf(email),
      from: email.from.address,
      to: email.to.map((mailbox) => mailbox.address),
      cc: email.cc.map((mailbox) => mailbox.address),
      subject: email.subject,
      text: transcript.entries[0]?.text ?? "",
      at: iso(email.createdAt),
      messageId: email.messageId,
      ...(email.delivery === undefined || deps.live
        ? {}
        : { delivery: deliveryWire(fake.delivery(session, email.delivery) as DeliveryRecord) }),
    };
  };
  const messageOf = (email: ResendEmailRecord) => ({
    id: email.id,
    author: world.principalOf(email),
    at: iso(email.createdAt),
    text: email.text,
    html: email.html,
    attachments: [],
  });

  const person = (session: string, id: string) => store.users.get(session, id);
  const emailOf = (session: string, id: string) => {
    const email = store.emails.find(id);
    // A session reads its own emails, and those of threads it owns (the agent's answers in them).
    const owner = email === undefined ? undefined : store.emails.owner(email.id);
    if (!email || (owner !== undefined && owner !== session && store.threads.owner(email.thread) !== session)) {
      throw new ProtocolError("not_found", `No resend email "${id}" in this session`, { id });
    }
    return email;
  };
  const threadOf = (session: string, id: string) => store.threads.get(session, id);
  /** A recipient: a person or the app by their handle. */
  const mailboxOf = (session: string, id: string) => {
    if (id === store.app.id) return { address: store.app.address, name: store.app.name };
    const user = person(session, id);
    return { address: user.address, name: user.name };
  };

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: "The Resend fixture: the agent's team, and where the agent reaches the fake",
    response: ResendFixture,
    factory: { on: "Session", name: "resend" },
    stability,
    handler: () => ({ app: appWire(), apiUrl: deps.live ? "https://api.resend.com" : deps.apiUrl() }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person: a mailbox, at `<name>@example.com` unless a test gives the address",
    body: z
      .object({
        name: z.string().min(1),
        address: z.string().optional().openapi({ description: "The person's address. Default `<name>@example.com`." }),
        token: z.string().min(1).optional().openapi({
          description:
            "Live: an API key of the person's own Resend team, which sends as them and reads their mail. Read from CHANNELSTACK_RESEND_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_RESEND_USER_{name}_TOKEN",
        }),
      })
      .openapi("ResendUserOptions"),
    response: ResendUser,
    errors: ["invalid_argument"],
    factory: { on: "ResendFixture", name: "createUser", options: ["name", "address", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  // --- What people do -------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/send",
    summary: "The person emails someone: the agent (`resend.app`), or another person",
    params: UserParams,
    body: z
      .object({
        to: recipients("Who it goes to: the app, people."),
        cc: recipients("Who gets a copy.").default([]),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
      })
      .openapi("ResendSendBody"),
    response: ResendEmail,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "ResendUser", name: "send", options: ["to", "cc", "subject", "text", "html"] },
    stability,
    handler: async ({ session, params, body }) => {
      if (body.to.length === 0) throw new ProtocolError("invalid_argument", "An email needs someone to go to");
      if (body.text === undefined && body.html === undefined) {
        throw new ProtocolError("invalid_argument", "An email needs `text` or `html`");
      }
      const email = await world.send(session.id, person(session.id, params.user), {
        to: body.to.map((id) => mailboxOf(session.id, id)),
        cc: body.cc.map((id) => mailboxOf(session.id, id)),
        subject: body.subject,
        text: body.text,
        html: body.html,
      });
      return emailWire(session.id, email);
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/reply",
    summary: "The person replies to an email, in its thread: `Re:` its subject, with `In-Reply-To` and `References`",
    params: UserParams,
    body: z
      .object({
        email: z.string().openapi(refTo("ResendEmail")),
        text: z.string().optional(),
        html: z.string().optional(),
        all: z
          .boolean()
          .default(false)
          .openapi({ description: "Reply to everyone on the email, not only its sender." }),
      })
      .openapi("ResendReplyBody"),
    response: ResendEmail,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "ResendUser", name: "reply", args: ["email"], options: ["text", "html", "all"] },
    stability,
    handler: async ({ session, params, body }) => {
      if (body.text === undefined && body.html === undefined) {
        throw new ProtocolError("invalid_argument", "A reply needs `text` or `html`");
      }
      const to = emailOf(session.id, body.email);
      const email = await world.reply(session.id, person(session.id, params.user), to, {
        text: body.text,
        html: body.html,
        all: body.all,
      });
      return emailWire(session.id, email);
    },
  });

  router.route({
    method: "get",
    path: "/users/{user}/inbox",
    summary: "What reached the person's mailbox, oldest first",
    params: UserParams,
    response: z.array(ResendEmail).openapi("ResendInbox"),
    errors: ["not_found"],
    sdkMethod: { on: "ResendUser", name: "inbox" },
    waits: [{ name: "waitForEmail", mode: "next", from: "author", what: "an email" }],
    stability,
    handler: async ({ session, params }) => {
      const user = person(session.id, params.user);
      return (await world.inbox(session.id, user)).map((email) => emailWire(session.id, email));
    },
  });

  // --- What a test reads ----------------------------------------------------------------------

  router.route({
    method: "get",
    path: "/emails/{email}",
    summary: "Re-read an email",
    params: EmailParams,
    response: ResendEmail,
    errors: ["not_found"],
    sdkMethod: { on: "ResendEmail", name: "refresh" },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id);
      return emailWire(session.id, emailOf(session.id, params.email));
    },
  });

  const emailsIn = async (session: string, thread: string) => {
    await world.refresh(session);
    return store.emailsIn(threadOf(session, thread).id);
  };

  router.route({
    method: "get",
    path: "/threads/{thread}/messages",
    summary: "Every email in the thread, oldest first",
    params: ThreadParams,
    response: z.array(ResendEmail).openapi("ResendMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "ResendThread", name: "messages" },
    stability,
    handler: async ({ session, params }) =>
      (await emailsIn(session.id, params.thread)).map((email) => emailWire(session.id, email)),
  });

  router.route({
    method: "get",
    path: "/threads/{thread}/replies",
    summary: "The thread's answers: every email after the first, oldest first",
    params: ThreadParams,
    response: z.array(ResendEmail).openapi("ResendReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "ResendThread", name: "replies" },
    waits: [
      { name: "waitForReply", mode: "next", from: "author", what: "a reply" },
      { name: "latestReply", mode: "latest", from: "author", what: "a reply" },
    ],
    stability,
    handler: async ({ session, params }) =>
      (await emailsIn(session.id, params.thread)).slice(1).map((email) => emailWire(session.id, email)),
  });

  router.route({
    method: "get",
    path: "/threads/{thread}/transcript",
    summary: "The thread as a person reads it: each email's own words, without the quoted history",
    params: ThreadParams,
    response: ResendTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "ResendThread", name: "transcript" },
    stability,
    handler: async ({ session, params }) =>
      threadTranscript((await emailsIn(session.id, params.thread)).map(messageOf)),
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Resend",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: ResendDelivery, wire: deliveryWire },
    listSummary: "Every webhook channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this event type, e.g. `email.received`.",
      resource: {
        description: "Only deliveries about this thread.",
        ref: "ResendThread",
        matches: ({ request }, thread) => request.meta?.thread === thread,
      },
    },
    live: { reads: DELIVERY_IS_THE_PLATFORMS, redeliver: NO_REDELIVERY },
    redeliver: { summary: "Send the same webhook again, as Resend retries: the same `svix-id`, signed again" },
    resend: {
      summary:
        "Send the webhook again, forged: signed with a secret that isn't the webhook's, or with a timestamp past the five minutes receivers accept",
      options: ["badSignature", "stale"],
    },
    calls: {
      schema: ResendApiCall,
      summary: "The REST calls the agent made about this session's emails, by the SDK's method name (`emails.send`)",
      live: AGENT_SIDE,
    },
  });
}
