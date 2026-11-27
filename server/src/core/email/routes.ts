import { z } from "@hono/zod-openapi";

import { iso } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../reality/index.ts";
import { type Awaitable, type DriverRouter, pathParam, refTo } from "../router/index.ts";
import { principalSchema, type TranscriptPrincipal, transcriptSchema } from "../router/inspect.ts";
import { type Mailbox, threadTranscript } from "./index.ts";
import type { EmailAppRecord, EmailPersonRecord, EmailRecord, EmailStore } from "./store.ts";

/**
 * The control API every email channel has (Resend, Gmail), written once: the fixture, its apps
 * (decision 0027) and what a scripted app sends, people who send, reply and read their inbox, and
 * the conversations a test reads. A channel adds its own
 * deliveries and calls (`registerInspectionRoutes`), and anything its email shows beyond these.
 */

/** What a person writes in an email. */
export interface EmailMessageInput {
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
}

/**
 * What people do on an email channel that works live, written once per channel. The fake implements
 * it over its world; live mode over the platform's API with each person's own account.
 */
export interface EmailWorld<Email extends EmailRecord, App extends EmailAppRecord = EmailAppRecord> {
  /** The mail as the routes read it: the fake's own, or live, what was read back from the platform. */
  readonly store: EmailStore<Email, App>;
  createUser(
    session: string,
    input: { name: string; address?: string | undefined; token?: string | undefined },
  ): Awaitable<EmailPersonRecord>;
  send(session: string, person: EmailPersonRecord, input: EmailMessageInput): Awaitable<Email>;
  reply(
    session: string,
    person: EmailPersonRecord,
    to: Email,
    input: { text: string | undefined; html: string | undefined; all: boolean },
  ): Awaitable<Email>;
  inbox(session: string, person: EmailPersonRecord): Awaitable<Email[]>;
  /** Read again what the agent may have changed: nothing to do in the fake, which holds the truth. */
  refresh(session: string): Awaitable<void>;
  principalOf(email: Email): TranscriptPrincipal;
}

/** What an app writes in an email: what a person does, and any headers of its own (`Auto-Submitted`). */
export type EmailAppMessageInput = EmailMessageInput & { readonly headers: Readonly<Record<string, string>> };

/**
 * The apps a test makes on an email channel (decision 0027), and what an app a test made does
 * when the test acts as it (a scripted app): each through the fake's own API, as that app's call
 * would. Fake only: live, each app is a sandbox app set up by hand.
 */
interface EmailApps<Email extends EmailRecord, App extends EmailAppRecord> {
  /** `createApp`: the app named `name` with the channel's settings, made the first time. */
  create(session: string, input: { readonly name: string } & Record<string, unknown>): Awaitable<App>;
  send(session: string, app: App, input: EmailAppMessageInput): Awaitable<Email>;
  reply(
    session: string,
    app: App,
    to: Email,
    input: { text: string | undefined; html: string | undefined; all: boolean; headers: Record<string, string> },
  ): Awaitable<Email>;
}

export interface EmailRoutesSpec<Email extends EmailRecord, App extends EmailAppRecord = EmailAppRecord> {
  /** The platform's name, the prefix of its types (`Resend`), and the channel's (`resend`). */
  readonly title: string;
  readonly channel: string;
  readonly world: EmailWorld<Email, App>;
  /** The channel's words for the agent's app (`team`, `mailbox`), its address, and the delivery an email to it causes. */
  readonly words: { readonly app: string; readonly address: string; readonly delivery: string };
  /** The fixture's `apiUrl`, and what it is to the agent. */
  readonly apiUrl: () => string;
  readonly apiUrlDescription: string;
  /** What a person's live `token` is on this platform. */
  readonly tokenDescription: string;
  /**
   * The channel's delivery, as an email to the agent carries the one that told it (`wire`), and
   * the one that told another app of it (`wireFor`, by the app's name).
   */
  readonly delivery: {
    readonly schema: z.ZodType;
    wire(session: string, email: Email): unknown | undefined;
    wireFor(session: string, email: Email, app: string): unknown | undefined;
  };
  /** What the channel's email shows beyond every channel's (Gmail's labels). */
  readonly emailFields?: { readonly shape: z.ZodRawShape; wire(email: Email): Record<string, unknown> };
  /** An email's headers by lower-case name, the first of each: what its writer set among them. */
  headers(email: Email): Record<string, string>;
  /** The apps tests make: the settings `createApp` takes beside `name`, and what an app handle shows of its own. */
  readonly apps: EmailApps<Email, App> & {
    readonly options: z.ZodRawShape;
    readonly fields: { readonly shape: z.ZodRawShape; wire(app: App): Record<string, unknown> };
  };
}

const UserParams = z.object({ user: pathParam("user") });
const AppParams = z.object({ app: pathParam("app") });
const EmailParams = z.object({ email: pathParam("email") });
const ThreadParams = z.object({ thread: pathParam("thread") });

/** Apps are the fake's: live, each would be a sandbox app of its own, which these channels don't have yet. */
const APPS_ARE_FAKE: LiveSupport = {
  unsupported: "Live, each app is a sandbox app set up by hand, and this channel has no second one yet (decision 0027)",
};

/** The email channel's control API. */
export function registerEmailRoutes<Email extends EmailRecord, App extends EmailAppRecord = EmailAppRecord>(
  router: DriverRouter,
  spec: EmailRoutesSpec<Email, App>,
): void {
  const { title, channel, world } = spec;
  const { store } = world;
  const stability = "experimental";
  const literal = z.literal(channel);

  const Principal = principalSchema(`${title}Principal`);
  const User = z
    .object({
      id: z.string().openapi({ description: "The person's address: an email person is their mailbox." }),
      channel: literal,
      kind: z.literal("user"),
      name: z.string(),
      address: z.string(),
    })
    .openapi(`${title}User`, { "x-channelstack-resource": { id: "id", role: "user" } });
  const App = z
    .object({
      id: z.string(),
      channel: literal,
      kind: z.literal("app"),
      name: z.string(),
      botUserId: z.string(),
      address: z.string().openapi({ description: spec.words.address }),
      ...spec.apps.fields.shape,
    })
    .openapi(`${title}App`, { "x-channelstack-resource": { id: "id", role: "app" } });
  const Thread = z
    .object({
      id: z.string().openapi({ description: "The id of the thread's first email." }),
      channel: literal,
      subject: z.string(),
    })
    .openapi(`${title}Thread`, { "x-channelstack-resource": { id: "id", role: "resource" } });
  const Email = z
    .object({
      id: z.string(),
      channel: literal,
      thread: Thread,
      author: Principal,
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      subject: z.string(),
      text: z.string().openapi({ description: "What its writer wrote, without the quoted history a reply carries." }),
      at: z.string(),
      messageId: z.string(),
      headers: z.record(z.string(), z.string()).openapi({
        description:
          "Its headers by lower-case name, the first of each: those its writer set too (`auto-submitted`, so a check can see an answer marked as automatic).",
      }),
      ...(spec.emailFields?.shape ?? {}),
      delivery: spec.delivery.schema.optional().openapi({ description: spec.words.delivery }),
    })
    .openapi(`${title}Email`, { "x-channelstack-resource": { id: "id" } });
  const Fixture = z
    .object({ app: App, apiUrl: z.string().openapi({ description: spec.apiUrlDescription }) })
    .openapi(`${title}Fixture`, { "x-channelstack-resource": {} });
  const Transcript = transcriptSchema(title, Principal);
  const recipients = (description: string) =>
    z.array(z.string().openapi(refTo(`${title}User`, `${title}App`))).openapi({ description });

  const appWire = (app: App) => ({
    id: app.id,
    channel,
    kind: "app" as const,
    name: app.name,
    botUserId: app.id,
    address: app.address,
    ...spec.apps.fields.wire(app),
  });
  const userWire = (user: EmailPersonRecord) => ({
    id: user.id,
    channel,
    kind: "user" as const,
    name: user.name,
    address: user.address,
  });
  const threadWire = (thread: string) => ({ id: thread, channel, subject: store.threads.find(thread)?.subject ?? "" });
  const messageOf = (email: Email) => ({
    id: email.id,
    author: world.principalOf(email),
    at: iso(email.createdAt),
    text: email.text,
    html: email.html,
    // A part the HTML shows by its `Content-ID` (`cid:logo`) is in the body a person reads, not a file of the email.
    attachments: email.attachments.flatMap((attachment) =>
      attachment.contentId === undefined ? [attachment.filename] : [],
    ),
  });
  const emailWire = (session: string, email: Email) => {
    const delivery = email.delivery === undefined ? undefined : spec.delivery.wire(session, email);
    return {
      id: email.id,
      channel,
      thread: threadWire(email.thread),
      author: world.principalOf(email),
      from: email.from.address,
      to: email.to.map((mailbox) => mailbox.address),
      cc: email.cc.map((mailbox) => mailbox.address),
      subject: email.subject,
      // What its writer wrote: the transcript names the attachments, the text doesn't.
      text: threadTranscript([{ ...messageOf(email), attachments: [] }]).entries[0]?.text ?? "",
      at: iso(email.createdAt),
      messageId: email.messageId,
      headers: spec.headers(email),
      ...(spec.emailFields?.wire(email) ?? {}),
      ...(delivery === undefined ? {} : { delivery }),
    };
  };

  const person = (session: string, id: string) => store.users.get(session, id);
  const emailOf = (session: string, id: string) => {
    const email = store.emails.find(id);
    // A session reads its own emails, and those of threads it owns (the agent's answers in them).
    const owner = email === undefined ? undefined : store.emails.owner(email.id);
    if (!email || (owner !== undefined && owner !== session && store.threads.owner(email.thread) !== session)) {
      throw new ProtocolError("not_found", `No ${channel} email "${id}" in this session`, { id });
    }
    return email;
  };
  /** A recipient: a person or an app by their handle. */
  const mailboxOf = (session: string, id: string): Mailbox => {
    const app = store.appOf(id);
    if (app) return { address: app.address, name: app.name };
    const user = person(session, id);
    return { address: user.address, name: user.name };
  };
  /** What someone writes to recipients given by handle, checked as every email is. */
  const message = (
    session: string,
    body: { to: string[]; cc: string[]; subject: string; text?: string | undefined; html?: string | undefined },
  ): EmailMessageInput => {
    if (body.to.length === 0) throw new ProtocolError("invalid_argument", "An email needs someone to go to");
    if (body.text === undefined && body.html === undefined) {
      throw new ProtocolError("invalid_argument", "An email needs `text` or `html`");
    }
    return {
      to: body.to.map((id) => mailboxOf(session, id)),
      cc: body.cc.map((id) => mailboxOf(session, id)),
      subject: body.subject,
      text: body.text,
      html: body.html,
    };
  };
  const appHeaders = z
    .record(z.string(), z.string())
    .default({})
    .openapi({ description: "Headers of its own, as its API call would set them: `Auto-Submitted: auto-replied`." });
  /** What a person sends. */
  const sendFields = {
    to: recipients("Who it goes to: apps, people."),
    cc: recipients("Who gets a copy.").default([]),
    subject: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
  };

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: `The ${title} fixture: the agent's ${spec.words.app}, and where the agent reaches the fake`,
    response: Fixture,
    factory: { on: "Session", name: channel },
    stability,
    handler: () => ({ app: appWire(store.app), apiUrl: spec.apiUrl() }),
  });

  // --- Apps -----------------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/apps",
    summary: `Make another app: a ${spec.words.app} of its own, with its own address and credentials (decision 0027), or return the one made with this name and settings. Its events go to CHANNELSTACK_${channel.toUpperCase()}_APP_<NAME>_WEBHOOK_URL`,
    body: z
      .object({
        name: z
          .string()
          .min(1)
          .openapi({ description: "Its name: 1 to 32 lower-case letters, digits and hyphens, from a letter" }),
        ...spec.apps.options,
      })
      .openapi(`${title}AppOptions`),
    response: App,
    errors: ["invalid_argument"],
    factory: { on: `${title}Fixture`, name: "createApp", options: ["name", ...Object.keys(spec.apps.options)] },
    live: APPS_ARE_FAKE,
    stability,
    handler: async ({ session, body }) => appWire(await spec.apps.create(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/apps",
    summary: `The channel's apps: the agent's ${spec.words.app} first, then the others in the order they were made`,
    response: z.array(App).openapi(`${title}Apps`),
    sdkMethod: { on: `${title}Fixture`, name: "apps" },
    stability,
    handler: () => store.apps.all().map(appWire),
  });

  router.route({
    method: "post",
    path: "/apps/{app}/send",
    summary: `An app a test made sends an email, through its own ${spec.words.app}'s API, as its own call would`,
    params: AppParams,
    body: z.object({ ...sendFields, headers: appHeaders }).openapi(`${title}AppSendBody`),
    response: Email,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: `${title}App`, name: "send", options: ["to", "cc", "subject", "text", "html", "headers"] },
    live: APPS_ARE_FAKE,
    stability,
    handler: async ({ session, params, body }) => {
      const app = store.scripted(params.app);
      const email = await spec.apps.send(session.id, app, { ...message(session.id, body), headers: body.headers });
      return emailWire(session.id, email);
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/reply",
    summary: "An app a test made replies to an email, in its thread, as its own call would",
    params: AppParams,
    body: z
      .object({
        email: z.string().openapi(refTo(`${title}Email`)),
        text: z.string().optional(),
        html: z.string().optional(),
        all: z
          .boolean()
          .default(false)
          .openapi({ description: "Reply to everyone on the email, not only its sender." }),
        headers: appHeaders,
      })
      .openapi(`${title}AppReplyBody`),
    response: Email,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: `${title}App`, name: "reply", args: ["email"], options: ["text", "html", "all", "headers"] },
    live: APPS_ARE_FAKE,
    stability,
    handler: async ({ session, params, body }) => {
      if (body.text === undefined && body.html === undefined) {
        throw new ProtocolError("invalid_argument", "A reply needs `text` or `html`");
      }
      const app = store.scripted(params.app);
      const email = await spec.apps.reply(session.id, app, emailOf(session.id, body.email), {
        text: body.text,
        html: body.html,
        all: body.all,
        headers: body.headers,
      });
      return emailWire(session.id, email);
    },
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person: a mailbox, at `<name>@example.com` unless a test gives the address",
    body: z
      .object({
        name: z.string().min(1),
        address: z.string().optional().openapi({ description: "The person's address. Default `<name>@example.com`." }),
        token: z
          .string()
          .min(1)
          .optional()
          .openapi({
            description: `${spec.tokenDescription} Read from CHANNELSTACK_${channel.toUpperCase()}_USER_<NAME>_TOKEN when left out.`,
            "x-channelstack-credential": `CHANNELSTACK_${channel.toUpperCase()}_USER_{name}_TOKEN`,
          }),
      })
      .openapi(`${title}UserOptions`),
    response: User,
    errors: ["invalid_argument"],
    factory: { on: `${title}Fixture`, name: "createUser", options: ["name", "address", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/users",
    summary: "The people this session created",
    response: z.array(User).openapi(`${title}Users`),
    sdkMethod: { on: `${title}Fixture`, name: "users" },
    stability,
    handler: ({ session }) => store.users.list(session.id).map(userWire),
  });

  router.route({
    method: "get",
    path: "/threads",
    summary: "The threads this session's people started, oldest first",
    response: z.array(Thread).openapi(`${title}Threads`),
    sdkMethod: { on: `${title}Fixture`, name: "threads" },
    stability,
    handler: async ({ session }) => {
      await world.refresh(session.id);
      return store.threads.list(session.id).map((thread) => threadWire(thread.id));
    },
  });

  // --- What people do -------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/send",
    summary: `The person emails someone: the agent (\`${channel}.app\`), another app, or another person`,
    params: UserParams,
    body: z.object(sendFields).openapi(`${title}SendBody`),
    response: Email,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: `${title}User`, name: "send", options: ["to", "cc", "subject", "text", "html"] },
    stability,
    handler: async ({ session, params, body }) => {
      const email = await world.send(session.id, person(session.id, params.user), message(session.id, body));
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
        email: z.string().openapi(refTo(`${title}Email`)),
        text: z.string().optional(),
        html: z.string().optional(),
        all: z
          .boolean()
          .default(false)
          .openapi({ description: "Reply to everyone on the email, not only its sender." }),
      })
      .openapi(`${title}ReplyBody`),
    response: Email,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: `${title}User`, name: "reply", args: ["email"], options: ["text", "html", "all"] },
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
    response: z.array(Email).openapi(`${title}Inbox`),
    errors: ["not_found"],
    sdkMethod: { on: `${title}User`, name: "inbox" },
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
    response: Email,
    errors: ["not_found"],
    sdkMethod: { on: `${title}Email`, name: "refresh" },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id);
      return emailWire(session.id, emailOf(session.id, params.email));
    },
  });

  router.route({
    method: "get",
    path: "/emails/{email}/delivery-for",
    summary: "The delivery that told this app of the email (decision 0027), or nothing when it wasn't told",
    params: EmailParams,
    query: z.object({ app: z.string().openapi({ param: { name: "app", in: "query" }, ...refTo(`${title}App`) }) }),
    response: spec.delivery.schema.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: `${title}Email`, name: "deliveryFor", args: ["app"] },
    live: DELIVERY_IS_THE_PLATFORMS,
    stability,
    handler: ({ session, params, query }) => {
      const app = store.appOf(query.app);
      if (!app) throw new ProtocolError("not_found", `There is no ${channel} app "${query.app}"`, { app: query.app });
      return spec.delivery.wireFor(session.id, emailOf(session.id, params.email), app.name) ?? null;
    },
  });

  const emailsIn = async (session: string, thread: string) => {
    await world.refresh(session);
    return store.emailsIn(store.threads.get(session, thread).id);
  };

  router.route({
    method: "get",
    path: "/threads/{thread}/messages",
    summary: "Every email in the thread, oldest first",
    params: ThreadParams,
    response: z.array(Email).openapi(`${title}Messages`),
    errors: ["not_found"],
    sdkMethod: { on: `${title}Thread`, name: "messages" },
    stability,
    handler: async ({ session, params }) =>
      (await emailsIn(session.id, params.thread)).map((email) => emailWire(session.id, email)),
  });

  router.route({
    method: "get",
    path: "/threads/{thread}/replies",
    summary: "The thread's answers: every email after the first, oldest first",
    params: ThreadParams,
    response: z.array(Email).openapi(`${title}Replies`),
    errors: ["not_found"],
    sdkMethod: { on: `${title}Thread`, name: "replies" },
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
    response: Transcript,
    errors: ["not_found"],
    sdkMethod: { on: `${title}Thread`, name: "transcript" },
    stability,
    handler: async ({ session, params }) =>
      threadTranscript((await emailsIn(session.id, params.thread)).map(messageOf)),
  });
}
