import { z } from "@hono/zod-openapi";

import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import type { DriverRouter } from "../../core/router/index.ts";
import {
  apiCallSchema,
  CallsQuery,
  DeliveryAttempt,
  DeliveryStatus,
  duration,
  principalSchema,
  readCalls,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import { type FakeNotionWorld, NotionApiError, type PlainValue } from "./fake/world.ts";
import { plainText } from "./rich-text.ts";
import { renderDiscussion, renderPage } from "./transcript.ts";
import type {
  NotionBlockRecord,
  NotionCommentRecord,
  NotionDatabaseRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionUserRecord,
} from "./world.ts";

const refTo = (...resources: string[]) => ({ "x-channelstack-ref": resources });
const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });
const iso = (ms: number) => new Date(ms).toISOString();

const NotionUser = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("user"),
    channel: z.literal("notion"),
    email: z.string().optional(),
  })
  .openapi("NotionUser", { "x-channelstack-resource": { id: "id" } });

const NotionIntegration = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("app"),
    channel: z.literal("notion"),
    botUserId: z.string(),
    token: z
      .string()
      .openapi({ description: "The internal integration token (`ntn_…`), as `channelstack env` prints it." }),
    webhookSecret: z
      .string()
      .openapi({ description: "The subscription's verification token: what webhooks are signed with." }),
  })
  .openapi("NotionIntegration", { "x-channelstack-resource": { id: "id" } });

const NotionAuthor = z.discriminatedUnion("kind", [NotionUser, NotionIntegration]);

const NotionPage = z
  .object({ id: z.string(), channel: z.literal("notion"), title: z.string(), url: z.string() })
  .openapi("NotionPage", { "x-channelstack-resource": { id: "id" } });

const NotionDatabase = z
  .object({ id: z.string(), channel: z.literal("notion"), title: z.string(), url: z.string() })
  .openapi("NotionDatabase", { "x-channelstack-resource": { id: "id" } });

const NotionDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("notion"),
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
  .union([z.string().min(1), z.object({ source: z.string().min(1), flags: z.string().regex(/^[imsu]*$/) })])
  .openapi({ "x-channelstack-pattern": true });

const UserParams = z.object({ user: pathParam("user") });
const PageParams = z.object({ page: pathParam("page") });
const DiscussionParams = z.object({ discussion: pathParam("discussion") });
const DeliveryParams = z.object({ delivery: pathParam("delivery") });

const PageOptions = z.object({
  title: z.string().min(1),
  parent: pageRef.optional(),
  content: Content.optional(),
  icon: z.string().optional(),
  connections: z.array(integrationRef).optional(),
});

/** The Notion driver's control API: what a test's people do, and what a test reads back. */
export function registerNotionRoutes(
  router: DriverRouter,
  deps: { world: FakeNotionWorld; events: EventLog; apiUrl: () => string; secret: (name: string) => string },
): void {
  const { world } = deps;
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

  const integrationWire = () => ({
    id: store.bot.id,
    name: store.bot.name,
    kind: "app" as const,
    channel: "notion" as const,
    botUserId: store.bot.id,
    token: deps.secret("token"),
    webhookSecret: deps.secret("verificationToken"),
  });
  const userWire = (user: NotionUserRecord) => ({
    id: user.id,
    name: user.name,
    kind: "user" as const,
    channel: "notion" as const,
    email: user.email,
  });
  const authorWire = (id: string) => {
    if (world.isBot(id)) return integrationWire();
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
    type: request.type,
    entity: (request.meta?.entity as { type: string; id: string } | undefined) ?? { type: "unknown", id: "" },
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const caused = (session: string, id: string | undefined) =>
    id === undefined ? undefined : deliveryWire(world.delivery(session, id));
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
  const integration = (id: string) => {
    if (id !== store.bot.id) throw new ProtocolError("not_found", `No Notion integration "${id}"`);
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
    handler: () => ({ app: integrationWire(), apiUrl: deps.apiUrl() }),
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
      })
      .openapi("NotionUserOptions"),
    response: NotionUser,
    factory: { on: "NotionFixture", name: "createUser", options: ["name", "id", "email", "avatarUrl"] },
    stability,
    handler: ({ session, body }) => userWire(world.createUser(session.id, body)),
  });

  router.route({
    method: "post",
    path: "/pages",
    summary:
      "Create a page as seed data: it sends no event. The integration sees it only through `connections`, its own or a parent's",
    body: PageOptions.extend({ createdBy: userRef.optional() }).openapi("NotionPageOptions"),
    response: NotionPage,
    errors: ["not_found"],
    factory: {
      on: "NotionFixture",
      name: "createPage",
      options: ["title", "parent", "content", "icon", "connections", "createdBy"],
    },
    stability,
    handler: ({ session, body }) => {
      if (body.parent) pageOf(session.id, body.parent);
      if (body.createdBy) person(session.id, body.createdBy);
      for (const id of body.connections ?? []) integration(id);
      return pageWire(asProtocol(() => world.createPage(session.id, body, { announce: false })).page);
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
    stability,
    handler: ({ session, body }) => {
      if (body.parent) pageOf(session.id, body.parent);
      for (const id of body.connections ?? []) integration(id);
      for (const schema of Object.values(body.properties))
        if (typeof schema === "object" && "relation" in schema) databaseOf(session.id, schema.relation);
      return databaseWire(asProtocol(() => world.createDatabase(session.id, body as never)));
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
    stability,
    handler: ({ session, body }) => {
      world.setContentDelay(session.id, body.delay);
    },
  });

  router.route({
    method: "post",
    path: "/verification",
    summary:
      "Send the subscription's verification request (`{ verification_token }`), as Notion does once when a subscription is created",
    response: NotionDelivery.nullable(),
    sdkMethod: { on: "NotionFixture", name: "sendVerification" },
    stability,
    handler: ({ session }) => caused(session.id, world.verify(session.id)) ?? null,
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      const rich = world.richText(session.id, body.text);
      return commentWire(
        session.id,
        asProtocol(() => world.comment(session.id, page, rich, user.id, body.anchor)),
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const discussion = discussionOf(session.id, body.discussion);
      const rich = world.richText(session.id, body.text);
      return commentWire(
        session.id,
        asProtocol(() => world.reply(session.id, discussion, rich, user.id)),
      );
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const comment = mine(session.id, user, body.comment);
      return (
        caused(session.id, world.editComment(session.id, comment, world.richText(session.id, body.text), user.id)) ??
        null
      );
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      return caused(session.id, world.deleteComment(session.id, mine(session.id, user, body.comment), user.id)) ?? null;
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      if (body.page.parent) live(pageOf(session.id, body.page.parent));
      for (const id of body.page.connections ?? []) integration(id);
      return pageWire(
        asProtocol(() => world.createPage(session.id, { ...body.page, createdBy: user.id }, { announce: true })).page,
      );
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      asProtocol(() => world.edit(session.id, live(pageOf(session.id, body.page)), body.change, user.id));
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      return (
        caused(session.id, world.rename(session.id, live(pageOf(session.id, body.page)), body.title, user.id)) ?? null
      );
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
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      integration(body.integration);
      world.mention(session.id, live(pageOf(session.id, body.page)), body.inBlock, user.id);
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
    stability,
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const page = live(pageOf(session.id, body.page));
      const property = asProtocol(() => world.propertyNamed(page, body.name));
      const value = world.fromPlain(property, body.value as PlainValue);
      return caused(session.id, world.setProperties(session.id, page, { [property.name]: value }, user.id)) ?? null;
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
    stability,
    handler: ({ session, params, body }) => {
      const user = person(session.id, params.user);
      const database = databaseOf(session.id, body.database);
      return pageWire(
        world.addRow(session.id, database, body.values as Record<string, PlainValue>, user.id, { announce: true }).page,
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
      stability,
      handler: ({ session, params, body }) => {
        person(session.id, params.user);
        integration(body.integration);
        const page = pageOf(session.id, body.page);
        if (connected) world.connect(page);
        else world.disconnect(page);
      },
    });

  // --- What a test reads: pages ---------------------------------------------------------------

  const pageRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (page: NotionPageRecord, session: string, query: Record<string, string | undefined>) => z.input<R>,
    extra: { query?: z.ZodObject<z.ZodRawShape>; args?: string[]; onceQuiet?: boolean } = {},
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
      stability,
      handler: ({ session, params, query }) =>
        read(pageOf(session.id, params.page), session.id, (query ?? {}) as Record<string, string | undefined>) as never,
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
      const property = asProtocol(() => world.propertyNamed(page, query.name ?? ""));
      return world.toPlain(page.properties[property.name]);
    },
    {
      query: z.object({ name: z.string().openapi({ param: { name: "name", in: "query", required: true } }) }),
      args: ["name"],
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
    (page) => (world.accessible(page.id) ? [integrationWire()] : []),
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
    stability,
    handler: ({ session, params, body }) =>
      world
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
    handler: ({ session, params }) =>
      world.commentsOf(discussionOf(session.id, params.discussion)).map((comment) => commentWire(session.id, comment)),
  });

  router.route({
    method: "get",
    path: "/discussions/{discussion}/resolved",
    summary: "Whether the discussion is resolved",
    params: DiscussionParams,
    response: z.boolean(),
    errors: ["not_found"],
    sdkMethod: { on: "NotionDiscussion", name: "resolved" },
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
    handler: ({ session, params }) => renderDiscussion(world, discussionOf(session.id, params.discussion), principal),
  });

  // --- Deliveries and calls ---------------------------------------------------------------------

  router.route({
    method: "get",
    path: "/deliveries",
    summary: "Every webhook channelstack sent the agent for this session, with every attempt",
    query: z.object({
      type: z
        .string()
        .optional()
        .openapi({
          param: { name: "type", in: "query" },
          description: "Only this event type, e.g. `comment.created`.",
        }),
      resource: z
        .string()
        .optional()
        .openapi({
          param: { name: "resource", in: "query" },
          description: "Only deliveries about this page.",
          ...refTo("NotionPage"),
        }),
    }),
    response: z.array(NotionDelivery).openapi("NotionDeliveries"),
    sdkMethod: { on: "NotionFixture", name: "deliveries", options: ["type", "resource"] },
    stability,
    handler: ({ session, query }) =>
      world
        .deliveries(session.id)
        .filter(({ request }) => query.type === undefined || request.type === query.type)
        .filter(({ request }) => query.resource === undefined || request.meta?.page === query.resource)
        .map(deliveryWire),
  });

  router.route({
    method: "get",
    path: "/deliveries/{delivery}",
    summary: "Re-read a delivery: its attempts and status",
    params: DeliveryParams,
    response: NotionDelivery,
    errors: ["not_found"],
    sdkMethod: { on: "NotionDelivery", name: "refresh" },
    waits: [{ name: "settled", mode: "until", field: "status", not: ["pending"], what: "the delivery to settle" }],
    stability,
    handler: ({ session, params }) => deliveryWire(world.delivery(session.id, params.delivery)),
  });

  router.route({
    method: "post",
    path: "/deliveries/{delivery}/redeliver",
    summary: "Send the same event again, as a retry does: the same body, the next `attempt_number`, signed again",
    params: DeliveryParams,
    response: DeliveryAttempt,
    errors: ["not_found"],
    sdkMethod: { on: "NotionDelivery", name: "redeliver" },
    stability,
    handler: ({ session, params }) => world.redeliver(session.id, params.delivery),
  });

  router.route({
    method: "post",
    path: "/deliveries/{delivery}/resend",
    summary: "Send the delivery again, signed with a token that isn't the subscription's",
    params: DeliveryParams,
    body: z.object({ badSignature: z.boolean().default(false) }).openapi("NotionResendBody"),
    response: DeliveryAttempt,
    errors: ["not_found"],
    sdkMethod: { on: "NotionDelivery", name: "resend", options: ["badSignature"] },
    stability,
    handler: ({ session, params, body }) => world.resend(session.id, params.delivery, body),
  });

  router.route({
    method: "get",
    path: "/calls",
    summary:
      "The REST calls the agent made about this session's pages, by the client's method name (`comments.create`)",
    query: CallsQuery,
    response: z.array(NotionApiCall).openapi("NotionApiCalls"),
    sdkMethod: { on: "NotionFixture", name: "calls", options: ["operation", "error"] },
    waits: [{ name: "waitForCall", mode: "next", filter: true, what: "an API call from the agent" }],
    stability,
    handler: ({ session, query }) => readCalls(deps.events, session.id, "notion", query),
  });
}
