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
import type { GoogleWorld } from "./backend.ts";
import type { FakeGoogleWorld } from "./fake/world.ts";
import { GMAIL_API } from "./live/client.ts";
import type { GoogleEmailRecord, GoogleUserRecord } from "./world.ts";

const GooglePrincipal = principalSchema("GooglePrincipal");

const GoogleUser = z
  .object({
    id: z.string().openapi({ description: "The person's address: an email person is their mailbox." }),
    channel: z.literal("google"),
    kind: z.literal("user"),
    name: z.string(),
    address: z.string(),
  })
  .openapi("GoogleUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const GoogleApp = z
  .object({
    id: z.string(),
    channel: z.literal("google"),
    kind: z.literal("app"),
    name: z.string(),
    botUserId: z.string(),
    address: z.string().openapi({ description: "Where people email the agent: its mailbox's address." }),
  })
  .openapi("GoogleApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const GoogleThread = z
  .object({
    id: z.string().openapi({ description: "The id of the thread's first email." }),
    channel: z.literal("google"),
    subject: z.string(),
  })
  .openapi("GoogleThread", { "x-channelstack-resource": { id: "id", role: "resource" } });

const GoogleDelivery = z
  .object({
    id: z.string().openapi({ description: "The Pub/Sub message's id." }),
    channel: z.literal("google"),
    type: z.string().openapi({ description: "`gmail.history`: the mailbox's history moved on." }),
    emailAddress: z.string().openapi({ description: "The mailbox the push is about." }),
    historyId: z.string().openapi({ description: "The mailbox's history id when the push was sent." }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("GoogleDelivery", { "x-channelstack-resource": { id: "id" } });

const GoogleEmail = z
  .object({
    id: z.string(),
    channel: z.literal("google"),
    thread: GoogleThread,
    author: GooglePrincipal,
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    subject: z.string(),
    text: z.string().openapi({ description: "What its writer wrote, without the quoted history a reply carries." }),
    at: z.string(),
    messageId: z.string(),
    labels: z.array(z.string()).openapi({
      description:
        "Its labels in the agent's mailbox (`INBOX`, `UNREAD`, `SENT`, the agent's own), for an email the agent has.",
    }),
    delivery: GoogleDelivery.optional().openapi({
      description: "The push that told the agent of it, for an email to it.",
    }),
  })
  .openapi("GoogleEmail", { "x-channelstack-resource": { id: "id" } });

const GoogleFixture = z
  .object({
    app: GoogleApp,
    apiUrl: z.string().openapi({
      description: "The root URL to give the agent's `googleapis` client (`GOOGLE_API_URL`, as `rootUrl`).",
    }),
  })
  .openapi("GoogleFixture", { "x-channelstack-resource": {} });

const GoogleTranscript = transcriptSchema("Google", GooglePrincipal);
const GoogleApiCall = apiCallSchema("google", "GoogleApiCall");

const UserParams = z.object({ user: pathParam("user") });
const EmailParams = z.object({ email: pathParam("email") });
const ThreadParams = z.object({ thread: pathParam("thread") });

const recipients = (description: string) =>
  z.array(z.string().openapi(refTo("GoogleUser", "GoogleApp"))).openapi({ description });

/** What only the agent's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Gmail doesn't report the mailbox's calls; proxy mode sees them",
};
/** Pub/Sub pushes again only what the agent didn't acknowledge. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Pub/Sub has no API to push an acknowledged message again" };

/** The Google driver's control API: what a test's people do, and what a test reads back. */
export function registerGoogleRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeGoogleWorld;
    live: GoogleWorld | undefined;
    world: GoogleWorld;
    events: EventLog;
    apiUrl: () => string;
  },
): void {
  const { fake, world } = deps;
  const { store } = world;
  const stability = "experimental";

  const appWire = () => ({
    id: store.app.id,
    channel: "google" as const,
    kind: "app" as const,
    name: store.app.name,
    botUserId: store.app.id,
    address: store.app.address,
  });
  const userWire = (user: GoogleUserRecord) => ({
    id: user.id,
    channel: "google" as const,
    kind: "user" as const,
    name: user.name,
    address: user.address,
  });
  const threadWire = (thread: string) => ({
    id: thread,
    channel: "google" as const,
    subject: store.threads.find(thread)?.subject ?? "",
  });
  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "google" as const,
    type: request.type,
    emailAddress: String(request.meta?.emailAddress ?? ""),
    historyId: String(request.meta?.historyId ?? ""),
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const emailWire = (session: string, email: GoogleEmailRecord) => {
    const transcript = threadTranscript([messageOf(email)]);
    return {
      id: email.id,
      channel: "google" as const,
      thread: threadWire(email.thread),
      author: world.principalOf(email),
      from: email.from.address,
      to: email.to.map((mailbox) => mailbox.address),
      cc: email.cc.map((mailbox) => mailbox.address),
      subject: email.subject,
      text: transcript.entries[0]?.text ?? "",
      at: iso(email.createdAt),
      messageId: email.messageId,
      labels: [...world.labelsOf(email)],
      ...(email.delivery === undefined || deps.live
        ? {}
        : { delivery: deliveryWire(fake.delivery(session, email.delivery) as DeliveryRecord) }),
    };
  };
  const messageOf = (email: GoogleEmailRecord) => ({
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
      throw new ProtocolError("not_found", `No google email "${id}" in this session`, { id });
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
    summary: "The Google fixture: the agent's mailbox, and where the agent reaches the fake",
    response: GoogleFixture,
    factory: { on: "Session", name: "google" },
    stability,
    handler: () => ({ app: appWire(), apiUrl: deps.live ? GMAIL_API : `${new URL(deps.apiUrl()).origin}/` }),
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
            "Live: a refresh token for the person's own Gmail account, from the agent's OAuth client, which sends as them and reads their mail. Read from CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_GOOGLE_USER_{name}_TOKEN",
        }),
      })
      .openapi("GoogleUserOptions"),
    response: GoogleUser,
    errors: ["invalid_argument"],
    factory: { on: "GoogleFixture", name: "createUser", options: ["name", "address", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  // --- What people do -------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/send",
    summary: "The person emails someone: the agent (`google.app`), or another person",
    params: UserParams,
    body: z
      .object({
        to: recipients("Who it goes to: the app, people."),
        cc: recipients("Who gets a copy.").default([]),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
      })
      .openapi("GoogleSendBody"),
    response: GoogleEmail,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "GoogleUser", name: "send", options: ["to", "cc", "subject", "text", "html"] },
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
        email: z.string().openapi(refTo("GoogleEmail")),
        text: z.string().optional(),
        html: z.string().optional(),
        all: z
          .boolean()
          .default(false)
          .openapi({ description: "Reply to everyone on the email, not only its sender." }),
      })
      .openapi("GoogleReplyBody"),
    response: GoogleEmail,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "GoogleUser", name: "reply", args: ["email"], options: ["text", "html", "all"] },
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
    response: z.array(GoogleEmail).openapi("GoogleInbox"),
    errors: ["not_found"],
    sdkMethod: { on: "GoogleUser", name: "inbox" },
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
    response: GoogleEmail,
    errors: ["not_found"],
    sdkMethod: { on: "GoogleEmail", name: "refresh" },
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
    response: z.array(GoogleEmail).openapi("GoogleMessages"),
    errors: ["not_found"],
    sdkMethod: { on: "GoogleThread", name: "messages" },
    stability,
    handler: async ({ session, params }) =>
      (await emailsIn(session.id, params.thread)).map((email) => emailWire(session.id, email)),
  });

  router.route({
    method: "get",
    path: "/threads/{thread}/replies",
    summary: "The thread's answers: every email after the first, oldest first",
    params: ThreadParams,
    response: z.array(GoogleEmail).openapi("GoogleReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "GoogleThread", name: "replies" },
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
    response: GoogleTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "GoogleThread", name: "transcript" },
    stability,
    handler: async ({ session, params }) =>
      threadTranscript((await emailsIn(session.id, params.thread)).map(messageOf)),
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Google",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: GoogleDelivery, wire: deliveryWire },
    listSummary: "Every push channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this kind: `gmail.history`.",
      resource: {
        description: "Only pushes that told of an email in this thread.",
        ref: "GoogleThread",
        matches: ({ request }, thread) =>
          ((request.meta?.emails as string[] | undefined) ?? []).some(
            (email) => store.emails.find(email)?.thread === thread,
          ),
      },
    },
    live: { reads: DELIVERY_IS_THE_PLATFORMS, redeliver: NO_REDELIVERY },
    redeliver: {
      summary: "Push the same message again, as Pub/Sub does when a push isn't acknowledged: the same message id",
    },
    resend: {
      summary:
        "Push it again, forged: with a token signed by another key, one that has expired, or one for another audience than the push endpoint",
      options: ["badSignature", "stale", "wrongAudience"],
    },
    calls: {
      schema: GoogleApiCall,
      summary:
        "The Gmail calls the agent made about this session's mail, by the SDK's method name (`users.messages.send`)",
      live: AGENT_SIDE,
    },
  });
}
