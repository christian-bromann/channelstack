import { z } from "@hono/zod-openapi";

import { BUILT_IN_APP, HANDLE_ONLY } from "../../core/apps/index.ts";
import { iso } from "../../core/clock/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import type { LiveSupport } from "../../core/reality/index.ts";
import { type DriverRouter, pathParam, refTo, registerInspectionRoutes } from "../../core/router/index.ts";
import {
  apiCallSchema,
  DeliveryAttempt,
  DeliveryStatus,
  duration,
  principalSchema,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import type { NotionWorld } from "./backend.ts";
import { NotionApiError } from "./errors.ts";
import type { FakeNotionWorld, PlainValue } from "./fake/world.ts";
import { NOTION_API } from "./live/client.ts";
import { plainText } from "./rich-text.ts";
import { renderDiscussion, renderPage } from "./transcript.ts";
import type {
  NotionBlockRecord,
  NotionBotRecord,
  NotionCommentRecord,
  NotionDatabaseRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionUserRecord,
} from "./world.ts";

const NotionUser = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("user"),
    channel: z.literal("notion"),
    email: z.string().optional(),
  })
  .openapi("NotionUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const NotionIntegration = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("app"),
    channel: z.literal("notion"),
    botUserId: z.string(),
    token: z.string().openapi({
      description: `The internal integration token (\`ntn_…\`), as \`channelstack env\` prints it. ${HANDLE_ONLY}`,
    }),
    webhookSecret: z.string().openapi({
      description: `The subscription's verification token: what webhooks are signed with. ${HANDLE_ONLY}`,
    }),
  })
  .openapi("NotionIntegration", { "x-channelstack-resource": { id: "id", role: "app" } });

const NotionAuthor = z.discriminatedUnion("kind", [NotionUser, NotionIntegration]);

const NotionPage = z
  .object({ id: z.string(), channel: z.literal("notion"), title: z.string(), url: z.string() })
  .openapi("NotionPage", { "x-channelstack-resource": { id: "id", role: "resource" } });

const NotionDatabase = z
  .object({ id: z.string(), channel: z.literal("notion"), title: z.string(), url: z.string() })
  .openapi("NotionDatabase", { "x-channelstack-resource": { id: "id", role: "resource" } });

const NotionDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("notion"),
    app: z.string().openapi({ description: "The integration it went to, by name: `my-agent`, or one a test made." }),
    type: z
      .string()
      .openapi({ description: "`comment.created`, `page.content_updated`, `page.properties_updated`, …" }),
    entity: z.object({ type: z.string(), id: z.string() }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("NotionDelivery", { "x-channelstack-resource": { id: "id" } });

const NotionDiscussion = z
  .object({
    id: z.string(),
    page: NotionPage,
    anchor: z
      .string()
      .optional()
      .openapi({ description: "The text of the block it is anchored to; none for the page." }),
  })
  .openapi("NotionDiscussion", { "x-channelstack-resource": { id: "id" } });

const NotionComment = z
  .object({
    id: z.string(),
    discussion: NotionDiscussion,
    author: NotionAuthor,
    text: z.string().openapi({ description: "As a person reads it: a mention is `@Name`." }),
    createdAt: z.string(),
    delivery: NotionDelivery.optional(),
  })
  .openapi("NotionComment", { "x-channelstack-resource": { id: "id" } });

const PropertyValue = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string()),
    z.object({ start: z.string(), end: z.string().optional() }),
  ])
  .openapi("NotionPropertyValue");

const PropertySchema = z
  .union([
    z.enum(["title", "rich_text", "number", "checkbox", "date", "people", "url", "email"]),
    z.object({ select: z.array(z.string()) }),
    z.object({ multi_select: z.array(z.string()) }),
    z.object({ status: z.array(z.string()) }),
    z.object({ relation: z.string().openapi(refTo("NotionDatabase")) }),
  ])
  .openapi("NotionPropertySchema");

const Principal = principalSchema("NotionPrincipal");

const NotionTranscript = transcriptSchema("Notion", Principal);

const NotionApiCall = apiCallSchema("notion", "NotionApiCall");

const NotionFixture = z
  .object({ app: NotionIntegration, apiUrl: z.string() })
  .openapi("NotionFixture", { "x-channelstack-resource": {} });

const userRef = z.string().openapi(refTo("NotionUser"));
const integrationRef = z.string().openapi(refTo("NotionIntegration"));
const pageRef = z.string().openapi(refTo("NotionPage"));
const databaseRef = z.string().openapi(refTo("NotionDatabase"));
const discussionRef = z.string().openapi(refTo("NotionDiscussion"));
const commentRef = z.string().openapi(refTo("NotionComment"));
const Content = z.union([z.string(), z.array(z.unknown())]).openapi({
  description: "Markdown, or Notion block objects as the API takes them. SDKs also take a fixture file (`{ path }`).",
  "x-channelstack-files": "document",
});
/** Text to find in a page: a string, or a pattern (SDKs send a `RegExp` as its source and flags). */
const TextPattern = z
  .union([z.string().min(1), z.object({ source: z.string().min(1), flags: z.string().regex(/^[dgimsuvy]*$/) })])
  .openapi({ "x-channelstack-pattern": true });

const UserParams = z.object({ user: pathParam("user") });
const AppParams = z.object({ app: pathParam("app") });
/** An integration's capabilities, as Notion's settings name them. */
const Capability = z
  .enum(["read_content", "update_content", "insert_content", "read_comments", "insert_comments", "read_user_info"])
  .openapi("NotionCapability");
const PageParams = z.object({ page: pathParam("page") });
const DiscussionParams = z.object({ discussion: pathParam("discussion") });

const PageOptions = z.object({
  title: z.string().min(1),
  parent: pageRef.optional(),
  content: Content.optional(),
  icon: z.string().optional(),
  connections: z.array(integrationRef).optional(),
});

/** The REST API has no resolve action and no resolved field: a person resolves in Notion's UI. */
const RESOLVE: LiveSupport = {
  unsupported: "not yet: Notion's API can't resolve or reopen a discussion, or say whether one is resolved",
};
/** How long Notion holds `page.content_updated` is Notion's own, and undocumented. */
const FAKE_BATCHING: LiveSupport = {
  unsupported: "Notion batches page.content_updated itself, for a time it doesn't document",
};
/** Notion sends the verification request once, when a subscription is created in its settings. */
const FAKE_VERIFICATION: LiveSupport = {
  unsupported: "Notion sends the verification request once, when the subscription is created",
};
/** Notion has no redelivery API. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Notion has no API to redeliver a webhook" };
/** Databases, their rows and properties aren't built live yet. */
const DATABASES: LiveSupport = { unsupported: "not yet: Notion databases, rows and properties aren't built live" };
/** No API adds or removes a connection: a person does it in Notion's UI (… → Connections). */
const CONNECTIONS: LiveSupport = {
  requires: "browser",
  reason: "no API connects a page to an integration; Notion's UI does (… → Connections)",
};
/** Integrations beside the built-in one are the fake's, for now (decision 0027's live part is still to come). */
const APPS: LiveSupport = { unsupported: "not yet: integrations beside the built-in one aren't built live" };
/** What only the integration's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Notion doesn't report the integration's calls; proxy mode sees them",
};

/** The Notion driver's control API: what a test's people do, and what a test reads back. */
export function registerNotionRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeNotionWorld;
    /** The live world, on a live driver. */
    live: NotionWorld | undefined;
    events: EventLog;
    apiUrl: () => string;
    /** One of an integration's secrets: the built-in one's unless another is named. */
    secret: (name: string, app?: string) => string;
  },
): void {
  const { fake } = deps;
  /** The world a route that works live acts in. Routes that don't are refused live by the router, and use the fake. */
  const world: NotionWorld = deps.live ?? fake;
  const isLive = deps.live !== undefined;
  const { store } = world;
  const stability = "experimental";

  /** A refusal of the API (Notion's `validation_error`), as the control API's error. */
  const asProtocol = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof NotionApiError) throw new ProtocolError("invalid_argument", error.message);
      throw error;
    }
  };

  // --- Records → wire ---------------------------------------------------------------------------

  /**
   * An integration as an author or a page's connection: who it is, without its credentials. Only
   * the integration a test asks for (the fixture's, `createApp`, `apps()`) carries them:
   * `integrationHandle`.
   */
  const integrationWire = (app: NotionBotRecord) => ({
    id: app.id,
    name: app.name,
    kind: "app" as const,
    channel: "notion" as const,
    botUserId: app.id,
    token: "",
    webhookSecret: "",
  });
  const integrationHandle = (app: NotionBotRecord) => ({
    ...integrationWire(app),
    // A live integration's credentials stay on the server: the control API never returns them.
    token: isLive ? "" : deps.secret("token", app.name),
    webhookSecret: isLive ? "" : deps.secret("verificationToken", app.name),
  });
  const userWire = (user: NotionUserRecord) => ({
    id: user.id,
    name: user.name,
    kind: "user" as const,
    channel: "notion" as const,
    // A live person's email never leaves the server: the live world keeps none.
    ...(user.email ? { email: user.email } : {}),
  });
  const authorWire = (id: string) => {
    const app = store.integration(id);
    if (app) return integrationWire(app);
    const user = store.user(id) as NotionUserRecord;
    return userWire(user);
  };
  const principal = (id: string) => {
    const { id: principalId, name, kind } = authorWire(id);
    return { id: principalId, name, kind };
  };
  const pageWire = (page: NotionPageRecord) => ({
    id: page.id,
    channel: "notion" as const,
    title: world.titleOf(page),
    url: world.links.page(page),
  });
  const databaseWire = (database: NotionDatabaseRecord) => ({
    id: database.id,
    channel: "notion" as const,
    title: database.title,
    url: world.links.database(database),
  });
  const deliveryWire = ({ request, attempts }: DeliveryRecord) => ({
    id: request.id,
    channel: "notion" as const,
    app: request.app ?? BUILT_IN_APP,
    type: request.type,
    entity: (request.meta?.entity as { type: string; id: string } | undefined) ?? { type: "unknown", id: "" },
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const caused = (session: string, id: string | undefined) =>
    id === undefined ? undefined : deliveryWire(fake.delivery(session, id));
  const discussionWire = (discussion: NotionDiscussionRecord) => ({
    id: discussion.id,
    page: pageWire(store.page(discussion.page)),
    anchor: discussion.anchor ?? undefined,
  });
  const commentWire = (session: string, comment: NotionCommentRecord) => ({
    id: comment.id,
    discussion: discussionWire(store.discussion(comment.discussion)),
    author: authorWire(comment.createdBy),
    text: plainText(comment.rich),
    createdAt: iso(comment.createdAt),
    delivery: caused(session, comment.delivery),
  });

  // --- Handles → records ------------------------------------------------------------------------

  const person = (session: string, id: string) => store.users.get(session, id);
  const pageOf = (session: string, id: string) => store.pages.get(session, id);
  const databaseOf = (session: string, id: string) => store.databases.get(session, id);
  const discussionOf = (session: string, id: string) => store.discussions.get(session, id);
  const commentOf = (session: string, id: string) => store.comments.get(session, id);
  /** An integration of the workspace by its handle: the built-in one, or one a test made. */
  const integration = (id: string): NotionBotRecord => {
    const app = store.integration(id);
    if (!app) throw new ProtocolError("not_found", `No Notion integration "${id}"`);
    return app;
  };
  /** A person may only write in a page they could open: the fake's workspace has no private pages for people. */
  const live = (page: NotionPageRecord) => {
    if (page.inTrash) throw new ProtocolError("not_found", `"${world.titleOf(page)}" is in the trash`);
    return page;
  };

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: "The Notion fixture: the agent's integration, and where the agent reaches the fake",
    response: NotionFixture,
    factory: { on: "Session", name: "notion" },
    stability,
    handler: () => ({ app: integrationHandle(store.bot), apiUrl: isLive ? NOTION_API : deps.apiUrl() }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person in the workspace",
    body: z
      .object({
        name: z.string().min(1),
        id: z.string().optional(),
        email: z.string().optional(),
        avatarUrl: z.string().optional(),
        token: z.string().min(1).optional().openapi({
          description:
            "A real person's personal access token in the live workspace, which acts as them. Read from CHANNELSTACK_NOTION_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_NOTION_USER_{name}_TOKEN",
        }),
      })
      .openapi("NotionUserOptions"),
    response: NotionUser,
    factory: { on: "NotionFixture", name: "createUser", options: ["name", "id", "email", "avatarUrl", "token"] },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  // --- Integrations (decision 0027) -----------------------------------------------------------

  /** What Notion's API refuses an integration a test acts as, with Notion's own code (`validation_error`). */
  const asPlatform = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof NotionApiError)
        throw new ProtocolError({ platform: error.code, status: error.status }, error.message);
      throw error;
    }
  };
  const SCRIPTED_ERRORS = ["not_found", "object_not_found", "restricted_resource", "validation_error"];

  router.route({
    method: "post",
    path: "/apps",
    summary:
      "Make another internal integration in the workspace, with its own bot user, token and webhook subscription (decision 0027), or return the one made with this name and settings. Its events go to CHANNELSTACK_NOTION_APP_<NAME>_WEBHOOK_URL, and it sees only the pages connected to it",
    body: z
      .object({
        name: z
          .string()
          .min(1)
          .openapi({ description: "How people mention it: 1 to 32 lower-case letters, digits and hyphens" }),
        capabilities: z
          .array(Capability)
          .optional()
          .openapi({ description: "What it may do, as in Notion's settings. Default: the built-in integration's" }),
        events: z
          .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/))
          .optional()
          .openapi({ description: "The events its webhook subscription sends. Default: the built-in integration's" }),
      })
      .openapi("NotionIntegrationOptions"),
    response: NotionIntegration,
    errors: ["invalid_argument"],
    factory: { on: "NotionFixture", name: "createApp", options: ["name", "capabilities", "events"] },
    live: APPS,
    stability,
    handler: ({ session, body }) => integrationHandle(fake.createApp(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/apps",
    summary: "The workspace's integrations: the built-in one first, then the others in the order they were made",
    response: z.array(NotionIntegration).openapi("NotionIntegrations"),
    sdkMethod: { on: "NotionFixture", name: "apps" },
    stability,
    handler: () => store.apps.all().map(integrationHandle),
  });

  router.route({
    method: "post",
    path: "/apps/{app}/comment",
    summary:
      "An integration a test made starts a discussion on a page, or anchored to the block with `anchor` in its text, as its own `comments.create` would: on a page connected to it, mentioning people only. Sends `comment.created` to every integration that sees the page",
    params: AppParams,
    body: z
      .object({ text: z.string().min(1), page: pageRef, anchor: TextPattern.optional() })
      .openapi("NotionAppCommentBody"),
    response: NotionComment,
    errors: SCRIPTED_ERRORS,
    sdkMethod: { on: "NotionIntegration", name: "comment", args: ["text"], options: ["page", "anchor"] },
    live: APPS,
    stability,
    handler: ({ session, params, body }) => {
      const page = live(pageOf(session.id, body.page));
      const rich = fake.richText(session.id, body.text);
      return commentWire(
        session.id,
        asPlatform(() => fake.commentAsApp(session.id, params.app, page, rich, body.anchor)),
      );
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/reply",
    summary:
      "An integration a test made replies in a discussion, as `comments.create` with `discussion_id` would. Sends `comment.created`",
    params: AppParams,
    body: z.object({ text: z.string().min(1), discussion: discussionRef }).openapi("NotionAppReplyBody"),
    response: NotionComment,
    errors: SCRIPTED_ERRORS,
    sdkMethod: { on: "NotionIntegration", name: "reply", args: ["text"], options: ["discussion"] },
    live: APPS,
    stability,
    handler: ({ session, params, body }) => {
      const discussion = discussionOf(session.id, body.discussion);
      const rich = fake.richText(session.id, body.text);
      return commentWire(
        session.id,
        asPlatform(() => fake.replyAsApp(session.id, params.app, discussion, rich)),
      );
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/edit",
    summary:
      "An integration a test made edits a page's body, as its own block calls would: append, or replace it. Sends one `page.content_updated` once Notion's batching delay is over",
    params: AppParams,
    body: z
      .object({ change: z.object({ append: Content.optional(), replace: Content.optional() }), page: pageRef })
      .openapi("NotionAppEditBody"),
    response: NotionDelivery.nullable(),
    errors: SCRIPTED_ERRORS,
    sdkMethod: { on: "NotionIntegration", name: "edit", args: ["change"], options: ["page"] },
    live: APPS,
    stability,
    handler: ({ session, params, body }) => {
      const page = live(pageOf(session.id, body.page));
      asPlatform(() => fake.editAsApp(session.id, params.app, page, body.change));
      // The event goes out when the batch does.
      return null;
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/rename",
    summary:
      "An integration a test made changes a page's title, as its own `pages.update` would. Sends `page.properties_updated`",
    params: AppParams,
    body: z.object({ title: z.string().min(1), page: pageRef }).openapi("NotionAppRenameBody"),
    response: NotionDelivery.nullable(),
    errors: SCRIPTED_ERRORS,
    sdkMethod: { on: "NotionIntegration", name: "rename", args: ["title"], options: ["page"] },
    live: APPS,
    stability,
    handler: ({ session, params, body }) => {
      const page = live(pageOf(session.id, body.page));
      return (
        caused(
          session.id,
          asPlatform(() => fake.renameAsApp(session.id, params.app, page, body.title)),
        ) ?? null
      );
    },
  });

  router.route({
    method: "get",
    path: "/users",
    summary: "The people this session created",
    response: z.array(NotionUser).openapi("NotionUsers"),
    sdkMethod: { on: "NotionFixture", name: "users" },
    stability,
    handler: ({ session }) => store.users.list(session.id).map(userWire),
  });

  router.route({
    method: "get",
    path: "/pages",
    summary:
      "The pages this session created, a database's rows included, read again from Notion live, oldest first. Not those in the trash",
    response: z.array(NotionPage).openapi("NotionPages"),
    sdkMethod: { on: "NotionFixture", name: "pages" },
    stability,
    handler: async ({ session }) => {
      const pages = store.pages.list(session.id);
      for (const page of pages) await world.refresh(session.id, { page: page.id });
      return pages.filter((page) => !page.inTrash).map(pageWire);
    },
  });

  router.route({
    method: "post",
    path: "/pages",
    summary:
      "Create a page as seed data. The integration sees it only through `connections`, its own or a parent's. In the fake it sends no event; live, a real person makes it, so Notion sends `page.created` to a connected integration. A person creating the page sends the event in both worlds",
    body: PageOptions.extend({ createdBy: userRef.optional() }).openapi("NotionPageOptions"),
    response: NotionPage,
    errors: ["not_found"],
    factory: {
      on: "NotionFixture",
      name: "createPage",
      options: ["title", "parent", "content", "icon", "connections", "createdBy"],
    },
    stability,
    handler: async ({ session, body }) => {
      if (body.parent) pageOf(session.id, body.parent);
      if (body.createdBy) person(session.id, body.createdBy);
      for (const id of body.connections ?? []) integration(id);
      return pageWire((await asProtocol(() => world.createPage(session.id, body, { announce: false }))).page);
    },
  });

  router.route({
    method: "post",
    path: "/databases",
    summary: "Create a database with its property schema and rows, as seed data",
    body: z
      .object({
        title: z.string().min(1),
        parent: pageRef.optional(),
        properties: z.record(z.string(), PropertySchema),
        rows: z.array(z.record(z.string(), PropertyValue)).optional(),
        connections: z.array(integrationRef).optional(),
      })
      .openapi("NotionDatabaseOptions"),
    response: NotionDatabase,
    errors: ["not_found", "invalid_argument"],
    factory: {
      on: "NotionFixture",
      name: "createDatabase",
      options: ["title", "parent", "properties", "rows", "connections"],
    },
    live: DATABASES,
    stability,
    handler: ({ session, body }) => {
      if (body.parent) pageOf(session.id, body.parent);
      for (const id of body.connections ?? []) integration(id);
      for (const schema of Object.values(body.properties))
        if (typeof schema === "object" && "relation" in schema) databaseOf(session.id, schema.relation);
      return databaseWire(asProtocol(() => fake.createDatabase(session.id, body as never)));
    },
  });

  router.route({
    method: "post",
    path: "/content-delay",
    summary:
      "How long Notion holds `page.content_updated` to batch edits, for this session (fake only). Default one second",
    body: z
      .object({ delay: duration("How long an edit waits for others to be sent with it.") })
      .openapi("NotionContentDelayBody"),
    sdkMethod: { on: "NotionFixture", name: "setContentUpdateDelay", args: ["delay"] },
    live: FAKE_BATCHING,
    stability,
    handler: ({ session, body }) => {
      fake.setContentDelay(session.id, body.delay);
    },
  });

  router.route({
    method: "post",
    path: "/verification",
    summary:
      "Send a subscription's verification request (`{ verification_token }`), as Notion does once when a subscription is created: the built-in integration's, or the one given's",
    body: z.object({ app: integrationRef.optional() }).openapi("NotionVerificationBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionFixture", name: "sendVerification", options: ["app"] },
    live: FAKE_VERIFICATION,
    stability,
    handler: ({ session, body }) => {
      const app = body?.app === undefined ? store.bot : integration(body.app);
      return caused(session.id, fake.verify(session.id, app)) ?? null;
    },
  });

  // --- What people do: comments ---------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/comment",
    summary:
      "Start a discussion on a page, or anchored to the block with `anchor` in its text. Sends `comment.created` if the integration can see the page",
    params: UserParams,
    body: z
      .object({ text: z.string().min(1), page: pageRef, anchor: TextPattern.optional() })
      .openapi("NotionCommentBody"),
    response: NotionComment,
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "comment", args: ["text"], options: ["page", "anchor"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      // An anchor is found in the page as it is now.
      if (body.anchor !== undefined) await world.refresh(session.id, { page: page.id });
      const rich = world.richText(session.id, body.text);
      return commentWire(
        session.id,
        await asProtocol(() => world.comment(session.id, page, rich, user.id, body.anchor)),
      );
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/reply",
    summary: "Reply in a discussion. Sends `comment.created`",
    params: UserParams,
    body: z.object({ text: z.string().min(1), discussion: discussionRef }).openapi("NotionReplyBody"),
    response: NotionComment,
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "reply", args: ["text"], options: ["discussion"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const discussion = discussionOf(session.id, body.discussion);
      const rich = world.richText(session.id, body.text);
      return commentWire(session.id, await asProtocol(() => world.reply(session.id, discussion, rich, user.id)));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/edit-comment",
    summary: "Edit one of this person's comments. Sends `comment.updated`",
    params: UserParams,
    body: z.object({ text: z.string().min(1), comment: commentRef }).openapi("NotionEditCommentBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "NotionUser", name: "editComment", args: ["text"], options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const comment = mine(session.id, user, body.comment);
      const rich = world.richText(session.id, body.text);
      return caused(session.id, await world.editComment(session.id, comment, rich, user.id)) ?? null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/delete-comment",
    summary: "Delete one of this person's comments. Sends `comment.deleted`",
    params: UserParams,
    body: z.object({ comment: commentRef }).openapi("NotionDeleteCommentBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "NotionUser", name: "deleteComment", options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const comment = mine(session.id, user, body.comment);
      return caused(session.id, await world.deleteComment(session.id, comment, user.id)) ?? null;
    },
  });
  const mine = (session: string, user: NotionUserRecord, id: string) => {
    const comment = commentOf(session, id);
    if (comment.createdBy !== user.id)
      throw new ProtocolError(
        { platform: "forbidden", status: 409 },
        `${user.name} can only change their own comments`,
      );
    return comment;
  };

  for (const [name, resolved] of [
    ["resolve", true],
    ["reopen", false],
  ] as const)
    router.route({
      method: "post",
      path: `/users/{user}/${name}`,
      summary: resolved
        ? "Resolve a discussion. Notion sends no event for it, and the API no longer lists its comments"
        : "Reopen a resolved discussion",
      params: UserParams,
      body: z.object({ discussion: discussionRef }).openapi(`Notion${name === "resolve" ? "Resolve" : "Reopen"}Body`),
      response: NotionDelivery.nullable(),
      errors: ["not_found"],
      sdkMethod: { on: "NotionUser", name, options: ["discussion"] },
      live: RESOLVE,
      stability,
      handler: ({ session, params, body }) => {
        person(session.id, params.user);
        discussionOf(session.id, body.discussion).resolved = resolved;
        return null;
      },
    });

  // --- What people do: pages ------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/pages",
    summary: "Create a page as this person. Sends `page.created` if the integration can see it",
    params: UserParams,
    body: z.object({ page: PageOptions }).openapi("NotionCreatePageBody"),
    response: NotionPage,
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "createPage", args: ["page"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      if (body.page.parent) live(pageOf(session.id, body.page.parent));
      for (const id of body.page.connections ?? []) integration(id);
      const created = await asProtocol(() =>
        world.createPage(session.id, { ...body.page, createdBy: user.id }, { announce: true }),
      );
      return pageWire(created.page);
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/edit",
    summary:
      "Edit a page's body: append, or replace it. Sends one `page.content_updated` once Notion's batching delay is over",
    params: UserParams,
    body: z
      .object({ change: z.object({ append: Content.optional(), replace: Content.optional() }), page: pageRef })
      .openapi("NotionEditBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "edit", args: ["change"], options: ["page"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      // A replace removes what the page has now.
      if (body.change.replace !== undefined) await world.refresh(session.id, { page: page.id });
      await asProtocol(() => world.edit(session.id, page, body.change, user.id));
      // The event goes out when the batch does.
      return null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/rename",
    summary: "Change a page's title. Sends `page.properties_updated`",
    params: UserParams,
    body: z.object({ title: z.string().min(1), page: pageRef }).openapi("NotionRenameBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "rename", args: ["title"], options: ["page"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      return caused(session.id, await world.rename(session.id, page, body.title, user.id)) ?? null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/mention",
    summary:
      "Mention the integration in the page body: in the block with `inBlock` in its text, or in a new paragraph. Sends `page.content_updated` after the batching delay",
    params: UserParams,
    body: z
      .object({ integration: integrationRef, page: pageRef, inBlock: TextPattern.optional() })
      .openapi("NotionMentionBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionUser", name: "mention", args: ["integration"], options: ["page", "inBlock"] },
    stability,
    handler: async ({ session, params, body }) => {
      const user = person(session.id, params.user);
      integration(body.integration);
      const page = live(pageOf(session.id, body.page));
      if (body.inBlock !== undefined) await world.refresh(session.id, { page: page.id });
      await world.mention(session.id, page, body.inBlock, user.id, body.integration);
      return null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/set-property",
    summary: "Set a property of a database row. Sends `page.properties_updated`",
    params: UserParams,
    body: z.object({ name: z.string().min(1), value: PropertyValue, page: pageRef }).openapi("NotionSetPropertyBody"),
    response: NotionDelivery.nullable(),
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "NotionUser", name: "setProperty", args: ["name", "value"], options: ["page"] },
    live: DATABASES,
    stability,
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      const property = asProtocol(() => fake.propertyNamed(page, body.name));
      const value = fake.fromPlain(property, body.value as PlainValue);
      return caused(session.id, fake.setProperties(session.id, page, { [property.name]: value }, user.id)) ?? null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/rows",
    summary: "Add a row to a database. Sends `page.created` if the integration can see the database",
    params: UserParams,
    body: z.object({ values: z.record(z.string(), PropertyValue), database: databaseRef }).openapi("NotionAddRowBody"),
    response: NotionPage,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "NotionUser", name: "addRow", args: ["values"], options: ["database"] },
    live: DATABASES,
    stability,
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const database = databaseOf(session.id, body.database);
      return pageWire(
        fake.addRow(session.id, database, body.values as Record<string, PlainValue>, user.id, { announce: true }).page,
      );
    },
  });

  for (const [name, connected] of [
    ["connect", true],
    ["disconnect", false],
  ] as const)
    router.route({
      method: "post",
      path: `/users/{user}/${name}`,
      summary: connected
        ? "Connect the integration to a page (Share → Connections): it sees the page and everything under it"
        : "Remove the integration's connection from a page",
      params: UserParams,
      body: z
        .object({ integration: integrationRef, page: pageRef })
        .openapi(`Notion${connected ? "Connect" : "Disconnect"}Body`),
      errors: ["not_found"],
      sdkMethod: { on: "NotionUser", name, args: ["integration"], options: ["page"] },
      live: CONNECTIONS,
      stability,
      handler: ({ session, params, body }) => {
        person(session.id, params.user);
        const app = integration(body.integration);
        const page = pageOf(session.id, body.page);
        if (connected) fake.connect(page, app.id);
        else fake.disconnect(page, app.id);
      },
    });

  // --- What a test reads: pages ---------------------------------------------------------------

  const pageRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (page: NotionPageRecord, session: string, query: Record<string, string | undefined>) => z.input<R>,
    extra: { query?: z.ZodObject<z.ZodRawShape>; args?: string[]; onceQuiet?: boolean; live?: LiveSupport } = {},
  ) =>
    router.route({
      method: "get",
      path: `/pages/{page}${path}`,
      summary,
      params: PageParams,
      ...(extra.query ? { query: extra.query } : {}),
      response,
      errors: ["not_found"],
      sdkMethod: {
        on: "NotionPage",
        name,
        ...(extra.args ? { args: extra.args } : {}),
        ...(extra.onceQuiet ? { onceQuiet: true } : {}),
      },
      ...(extra.live ? { live: extra.live } : {}),
      stability,
      handler: async ({ session, params, query }) => {
        await world.refresh(session.id, { page: pageOf(session.id, params.page).id });
        const page = pageOf(session.id, params.page);
        return read(page, session.id, (query ?? {}) as Record<string, string | undefined>) as never;
      },
    });

  pageRead(
    "/discussions",
    "discussions",
    "The page's discussions: on the page itself, and on its blocks",
    z.array(NotionDiscussion).openapi("NotionDiscussions"),
    (page) => world.discussionsOf(page).map(discussionWire),
  );
  pageRead(
    "/markdown",
    "markdown",
    "The page body as Markdown, once the agent is quiet",
    z.string(),
    (page) => world.markdownOf(page),
    {
      onceQuiet: true,
    },
  );
  pageRead(
    "/blocks",
    "blocks",
    "The page's blocks as the API has them, with nested blocks under `children`",
    z.array(z.unknown()).openapi("NotionBlocks"),
    (page) => {
      const tree = (ids: readonly string[]): unknown[] =>
        world.childrenOf(ids).map((block: NotionBlockRecord) => ({
          ...world.objects.block({ ...block, data: world.dataOf(block) }),
          children: tree(block.children),
        }));
      return tree(page.children);
    },
  );
  pageRead(
    "/property",
    "property",
    "A property's value as a person reads it: text, a number, option names, ids",
    PropertyValue,
    (page, _session, query) => {
      const property = asProtocol(() => fake.propertyNamed(page, query.name ?? ""));
      return fake.toPlain(page.properties[property.name]);
    },
    {
      query: z.object({ name: z.string().openapi({ param: { name: "name", in: "query", required: true } }) }),
      args: ["name"],
      live: DATABASES,
    },
  );
  pageRead(
    "/children",
    "children",
    "The pages directly under this page",
    z.array(NotionPage).openapi("NotionChildPages"),
    (page) => store.childPages(page.id).map(pageWire),
  );
  pageRead(
    "/connections",
    "connections",
    "The integrations that can see the page: connected to it or to a page above it",
    z.array(NotionIntegration).openapi("NotionConnections"),
    (page) =>
      store.apps
        .all()
        .filter((app) => world.accessible(page.id, app.id))
        .map((app) => integrationWire(app)),
  );
  pageRead(
    "/transcript",
    "transcript",
    "The page and its discussions as a person reads them",
    NotionTranscript,
    (page) => renderPage(world, page, principal),
  );

  router.route({
    method: "post",
    path: "/databases/{database}/rows",
    summary: "The rows of a database, optionally only those whose properties have these values",
    params: z.object({ database: pathParam("database") }),
    body: z.object({ filter: z.record(z.string(), PropertyValue).optional() }).openapi("NotionRowsBody"),
    response: z.array(NotionPage).openapi("NotionRows"),
    errors: ["not_found"],
    sdkMethod: { on: "NotionDatabase", name: "rows", args: ["filter"] },
    live: DATABASES,
    stability,
    handler: ({ session, params, body }) =>
      fake
        .rows(databaseOf(session.id, params.database), (body.filter ?? {}) as Record<string, PlainValue>)
        .map(pageWire),
  });

  // --- What a test reads: discussions ---------------------------------------------------------

  router.route({
    method: "get",
    path: "/discussions/{discussion}/comments",
    summary: "The discussion's comments, oldest first",
    params: DiscussionParams,
    response: z.array(NotionComment).openapi("NotionComments"),
    errors: ["not_found"],
    sdkMethod: { on: "NotionDiscussion", name: "comments" },
    waits: [
      { name: "waitForComment", mode: "next", from: "author", what: "a comment" },
      { name: "latestComment", mode: "latest", from: "author", what: "a comment" },
    ],
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id, { discussion: discussionOf(session.id, params.discussion).id });
      const discussion = discussionOf(session.id, params.discussion);
      return world.commentsOf(discussion).map((comment) => commentWire(session.id, comment));
    },
  });

  router.route({
    method: "get",
    path: "/discussions/{discussion}/resolved",
    summary: "Whether the discussion is resolved",
    params: DiscussionParams,
    response: z.boolean(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionDiscussion", name: "resolved" },
    live: RESOLVE,
    stability,
    handler: ({ session, params }) => discussionOf(session.id, params.discussion).resolved,
  });

  router.route({
    method: "get",
    path: "/discussions/{discussion}/transcript",
    summary: "The discussion as a person reads it",
    params: DiscussionParams,
    response: NotionTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "NotionDiscussion", name: "transcript" },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id, { discussion: discussionOf(session.id, params.discussion).id });
      return renderDiscussion(world, discussionOf(session.id, params.discussion), principal);
    },
  });

  router.route({
    method: "get",
    path: "/comments/{comment}/delivery-for",
    summary:
      "The `comment.created` delivery this comment caused to this integration (decision 0027), or nothing when it wasn't told. The comment's `delivery` is the built-in integration's",
    params: z.object({ comment: pathParam("comment") }),
    query: z.object({
      app: z.string().openapi({ param: { name: "app", in: "query" }, ...refTo("NotionIntegration") }),
    }),
    response: NotionDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionComment", name: "deliveryFor", args: ["app"] },
    live: APPS,
    stability,
    handler: ({ session, params, query }) => {
      const comment = commentOf(session.id, params.comment);
      const app = store.apps.get(session.id, query.app);
      const found = fake
        .deliveries(session.id)
        .find(
          ({ request }) =>
            request.app === app.name &&
            request.type === "comment.created" &&
            (request.meta?.entity as { id?: string } | undefined)?.id === comment.id,
        );
      return found ? deliveryWire(found) : null;
    },
  });

  // --- Deliveries and calls ---------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Notion",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: NotionDelivery, wire: deliveryWire },
    apps: { handle: "NotionIntegration", roster: store.apps },
    listSummary: "Every webhook channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this event type, e.g. `comment.created`.",
      resource: {
        description: "Only deliveries about this page.",
        ref: "NotionPage",
        matches: ({ request }, page) => request.meta?.page === page,
      },
    },
    live: { redeliver: NO_REDELIVERY },
    redeliver: {
      summary: "Send the same event again, as a retry does: the same body, the next `attempt_number`, signed again",
    },
    resend: {
      summary: "Send the delivery again, signed with a token that isn't the subscription's",
      options: ["badSignature"],
    },
    calls: {
      schema: NotionApiCall,
      summary:
        "The REST calls the agent made about this session's pages, by the client's method name (`comments.create`)",
      live: AGENT_SIDE,
    },
  });
}
