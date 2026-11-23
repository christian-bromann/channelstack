import { type Context, Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { recordCall } from "../../../core/router/inspect.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { NOTION_API_VERSION } from "../payloads.ts";
import type { NotionBlockRecord, NotionCapability, NotionDatabaseRecord, NotionPageRecord } from "../world.ts";
import { type FakeNotionWorld, NotionApiError, type PlainValue } from "./world.ts";

/** The versions the API takes; the client libraries send one in `Notion-Version`. */
const VERSIONS = ["2022-06-28", NOTION_API_VERSION, "2026-03-11"];

/** What each operation needs the integration to be allowed, as its capabilities in Notion's settings. */
const NEEDS: Readonly<Record<string, NotionCapability>> = {
  "users.list": "read_user_info",
  "users.retrieve": "read_user_info",
  "pages.retrieve": "read_content",
  "pages.properties.retrieve": "read_content",
  "pages.create": "insert_content",
  "pages.update": "update_content",
  "blocks.retrieve": "read_content",
  "blocks.children.list": "read_content",
  "blocks.children.append": "insert_content",
  "blocks.update": "update_content",
  "blocks.delete": "update_content",
  "databases.retrieve": "read_content",
  "dataSources.retrieve": "read_content",
  "dataSources.query": "read_content",
  search: "read_content",
  "comments.list": "read_comments",
  "comments.retrieve": "read_comments",
  "comments.create": "insert_comments",
};

/** A path parameter: every route here names the ones it reads. */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

interface Answer {
  body: unknown;
  /** The test sessions whose objects the call read or changed. */
  sessions: Iterable<string>;
  status?: number;
}

/**
 * Notion's REST API, as the integration sees it (`@notionhq/client` at API version `2025-09-03`):
 * the integration's token, and only what it is connected to. Each call is on record for the test
 * sessions whose objects it read or changed, by the client's method name (`comments.create`).
 */
export function createNotionApi(context: DriverContext, world: FakeNotionWorld): Hono {
  const { store, objects } = world;
  const { clock } = context;
  const api = new Hono();
  const bot = () => store.bot.id;
  const requestId = () => context.ids.next("notion.uuid");

  const errorBody = (status: number, code: string, message: string) => ({
    object: "error",
    status,
    code,
    message,
    request_id: requestId(),
  });

  /** A block as the API shows it: a `child_page` has its page's current title. */
  const blockObject = (block: NotionBlockRecord) => objects.block({ ...block, data: world.dataOf(block) });
  const sessionOf = (id: string) => store.sessionOf(id);

  const endpoint = (
    method: "get" | "post" | "patch" | "delete",
    path: string,
    operation: string,
    handle: (c: Context, body: Record<string, unknown>) => Answer,
  ) =>
    api.on(method.toUpperCase(), path, async (c) => {
      const startedAt = clock();
      const token = bearerFrom(c.req.header("authorization")) ?? "";
      if (token === "" || !constantTimeEqual(token, context.secret("token")))
        return c.json(errorBody(401, "unauthorized", "API token is invalid."), 401);
      const version = c.req.header("notion-version");
      if (version === undefined)
        return c.json(
          errorBody(
            400,
            "missing_version",
            "Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.",
          ),
          400,
        );
      if (!VERSIONS.includes(version))
        return c.json(
          errorBody(
            400,
            "validation_error",
            `Notion-Version header failed validation: ${version} is not a supported version.`,
          ),
          400,
        );
      const needs = NEEDS[operation];
      if (needs && !store.bot.capabilities.includes(needs))
        return c.json(errorBody(403, "restricted_resource", "Insufficient permissions for this endpoint."), 403);

      let body: Record<string, unknown> = {};
      if (method === "post" || method === "patch") {
        const text = await c.req.text();
        try {
          body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
        } catch {
          return c.json(errorBody(400, "invalid_json", "Error parsing JSON body."), 400);
        }
      }

      let answer: Answer;
      try {
        answer = handle(c, body);
      } catch (error) {
        if (!(error instanceof NotionApiError)) throw error;
        answer = { body: errorBody(error.status, error.code, error.message), sessions: [], status: error.status };
      }
      const status = answer.status ?? 200;
      const url = new URL(c.req.url);
      recordCall(
        context.events,
        "notion",
        answer.sessions,
        {
          operation,
          method: method.toUpperCase(),
          path: url.pathname,
          request: method === "get" || method === "delete" ? Object.fromEntries(url.searchParams) : body,
          responseStatus: status,
          response: answer.body,
          error: status >= 400 ? String((answer.body as { code?: string }).code ?? "error") : undefined,
          durationMs: clock() - startedAt,
        },
        { unattributed: "world" },
      );
      return c.json(answer.body, status as 200);
    });

  const paging = (c: Context) => ({
    start_cursor: c.req.query("start_cursor"),
    page_size: c.req.query("page_size") === undefined ? undefined : Number(c.req.query("page_size")),
  });
  const bodyPaging = (body: Record<string, unknown>) => ({
    start_cursor: typeof body.start_cursor === "string" ? body.start_cursor : undefined,
    page_size: typeof body.page_size === "number" ? body.page_size : undefined,
  });

  // --- Users ----------------------------------------------------------------------------------

  endpoint("get", "/v1/users/me", "users.me", () => ({ body: objects.user(store.bot, false), sessions: [] }));
  endpoint("get", "/v1/users", "users.list", (c) => {
    const people = [store.owner, ...store.users.values()];
    const list = objects.list(
      "user",
      [...people.map((user) => objects.user(user, true)), objects.user(store.bot, false)],
      paging(c),
      (user) => user.id,
    );
    return {
      body: list,
      sessions: list.results.flatMap((user) => (store.users.owner(user.id) ? [sessionOf(user.id)] : [])),
    };
  });
  endpoint("get", "/v1/users/:id", "users.retrieve", (c) => {
    const id = param(c, "id");
    const user = store.user(id);
    if (!user) throw new NotionApiError(404, "object_not_found", `Could not find user with ID: ${id}.`);
    return { body: objects.user(user, true), sessions: store.users.owner(id) ? [sessionOf(id)] : [] };
  });

  // --- Pages ----------------------------------------------------------------------------------

  endpoint("get", "/v1/pages/:id", "pages.retrieve", (c) => {
    const page = world.visiblePage(param(c, "id"));
    return { body: objects.page(page), sessions: [sessionOf(page.id)] };
  });

  endpoint("get", "/v1/pages/:id/properties/:property", "pages.properties.retrieve", (c) => {
    const page = world.visiblePage(param(c, "id"));
    const property = world.schemaOf(page).find((candidate) => candidate.id === param(c, "property"));
    if (!property)
      throw new NotionApiError(404, "object_not_found", `Could not find property with ID: ${param(c, "property")}.`);
    return {
      body: { object: "property_item", ...objects.propertyValue(property, page.properties[property.name]) },
      sessions: [sessionOf(page.id)],
    };
  });

  endpoint("post", "/v1/pages", "pages.create", (_c, body) => {
    const parent = body.parent as
      { page_id?: string; database_id?: string; data_source_id?: string; type?: string } | undefined;
    const children = Array.isArray(body.children) ? body.children : [];
    const properties = (body.properties ?? {}) as Record<string, unknown>;
    if (parent?.page_id) {
      const above = world.visiblePage(parent.page_id);
      const page = world.createPageAs(
        sessionOf(above.id),
        { type: "page_id", id: above.id },
        properties,
        children,
        bot(),
      );
      return { body: objects.page(page), sessions: [sessionOf(page.id)] };
    }
    const id = parent?.data_source_id ?? parent?.database_id;
    if (id === undefined)
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: body.parent should be a page_id, database_id or data_source_id.",
      );
    const database = world.visibleDatabase(id);
    const page = world.createPageAs(
      sessionOf(database.id),
      { type: "database_id", id: database.id, dataSource: database.dataSource },
      properties,
      children,
      bot(),
    );
    return { body: objects.page(page), sessions: [sessionOf(page.id)] };
  });

  endpoint("patch", "/v1/pages/:id", "pages.update", (c, body) => {
    const page = world.visiblePage(param(c, "id"));
    world.updatePage(sessionOf(page.id), page, body, bot());
    return { body: objects.page(page), sessions: [sessionOf(page.id)] };
  });

  // --- Blocks ---------------------------------------------------------------------------------

  endpoint("get", "/v1/blocks/:id", "blocks.retrieve", (c) => {
    const id = param(c, "id");
    const { block, page } = world.visibleBlock(id);
    // A page read as a block is its `child_page` block, or for a top-level page one made up for it.
    const record = block ?? store.blocks.find(id) ?? pageAsBlock(page);
    return { body: blockObject(record), sessions: [sessionOf(page.id)] };
  });
  const pageAsBlock = (page: NotionPageRecord): NotionBlockRecord => ({
    id: page.id,
    page: page.id,
    parent: { type: "page_id", id: page.id },
    type: "child_page",
    data: {},
    children: page.children,
    createdBy: page.createdBy,
    lastEditedBy: page.lastEditedBy,
    createdAt: page.createdAt,
    lastEditedAt: page.lastEditedAt,
    inTrash: page.inTrash,
  });

  endpoint("get", "/v1/blocks/:id/children", "blocks.children.list", (c) => {
    const target = world.visibleBlock(param(c, "id"));
    const children = world.childrenOf(target.block ? target.block.children : target.page.children);
    return {
      body: objects.list("block", children.map(blockObject), paging(c), (block) => block.id),
      sessions: [sessionOf(target.page.id)],
    };
  });

  endpoint("patch", "/v1/blocks/:id/children", "blocks.children.append", (c, body) => {
    const target = world.visibleBlock(param(c, "id"));
    if (!Array.isArray(body.children) || body.children.length === 0)
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: body.children should be a non-empty array.",
      );
    if (body.children.length > 100)
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: body.children.length should be ≤ `100`.",
      );
    const position = body.position as { type?: string; after_block?: { id?: string } } | undefined;
    const after =
      typeof body.after === "string"
        ? body.after
        : position?.type === "after_block"
          ? position.after_block?.id
          : undefined;
    const session = sessionOf(target.page.id);
    const added = world.append(session, target, body.children, bot(), after);
    return {
      body: objects.list(
        "block",
        added.map((id) => blockObject(store.block(id))),
        {},
        (block) => block.id,
      ),
      sessions: [session],
    };
  });

  endpoint("patch", "/v1/blocks/:id", "blocks.update", (c, body) => {
    const { block, page } = world.visibleBlock(param(c, "id"));
    if (!block) {
      world.updatePage(sessionOf(page.id), page, body, bot());
      return { body: blockObject(pageAsBlock(page)), sessions: [sessionOf(page.id)] };
    }
    return {
      body: blockObject(world.updateBlock(sessionOf(page.id), block, body, bot())),
      sessions: [sessionOf(page.id)],
    };
  });

  endpoint("delete", "/v1/blocks/:id", "blocks.delete", (c) => {
    const { block, page } = world.visibleBlock(param(c, "id"));
    if (!block) {
      world.updatePage(sessionOf(page.id), page, { in_trash: true }, bot());
      return { body: blockObject(pageAsBlock(page)), sessions: [sessionOf(page.id)] };
    }
    return { body: blockObject(world.removeBlock(sessionOf(page.id), block, bot())), sessions: [sessionOf(page.id)] };
  });

  // --- Databases and data sources -------------------------------------------------------------

  endpoint("get", "/v1/databases/:id", "databases.retrieve", (c) => {
    const database = world.visibleDatabase(param(c, "id"));
    return { body: objects.database(database), sessions: [sessionOf(database.id)] };
  });

  endpoint("get", "/v1/data_sources/:id", "dataSources.retrieve", (c) => {
    const database = world.visibleDatabase(param(c, "id"));
    return { body: objects.dataSource(database), sessions: [sessionOf(database.id)] };
  });

  endpoint("post", "/v1/data_sources/:id/query", "dataSources.query", (c, body) => {
    const database = world.visibleDatabase(param(c, "id"));
    const rows = sorted(
      database,
      world.rows(database).filter((row) => matches(database, row, body.filter)),
      body.sorts,
    );
    return {
      body: objects.list("page_or_data_source", rows.map(objects.page), bodyPaging(body), (page) => page.id),
      sessions: [sessionOf(database.id)],
    };
  });

  /** Does a row pass a data source filter: a property condition, or `and` / `or` of them. */
  const matches = (database: NotionDatabaseRecord, row: NotionPageRecord, filter: unknown): boolean => {
    if (filter === undefined || filter === null) return true;
    const input = filter as Record<string, unknown>;
    if (Array.isArray(input.and)) return input.and.every((inner) => matches(database, row, inner));
    if (Array.isArray(input.or)) return input.or.some((inner) => matches(database, row, inner));
    if (typeof input.property !== "string") return true;
    const property = database.properties.find(
      (candidate) => candidate.name === input.property || candidate.id === input.property,
    );
    if (!property)
      throw new NotionApiError(400, "validation_error", `Could not find property with name or id: ${input.property}`);
    const condition = (Object.entries(input).find(([key]) => key !== "property")?.[1] ?? {}) as Record<string, unknown>;
    const value = world.toPlain(row.properties[property.name]);
    const [operator, operand] = Object.entries(condition)[0] ?? ["is_not_empty", true];
    const text = Array.isArray(value)
      ? value
      : value === null
        ? ""
        : String(typeof value === "object" ? value.start : value);
    switch (operator) {
      case "equals":
        return Array.isArray(text) ? text.includes(String(operand)) : text === String(operand);
      case "does_not_equal":
        return text !== String(operand);
      case "contains":
        return Array.isArray(text)
          ? text.includes(String(operand))
          : text.toLowerCase().includes(String(operand).toLowerCase());
      case "does_not_contain":
        return !(Array.isArray(text) ? text.includes(String(operand)) : text.includes(String(operand)));
      case "is_empty":
        return value === null || text.length === 0;
      case "is_not_empty":
        return !(value === null || text.length === 0);
      case "greater_than":
        return typeof value === "number" && value > Number(operand);
      case "less_than":
        return typeof value === "number" && value < Number(operand);
      default:
        return true;
    }
  };

  const sorted = (database: NotionDatabaseRecord, rows: NotionPageRecord[], sorts: unknown): NotionPageRecord[] => {
    if (!Array.isArray(sorts)) return rows;
    return [...rows].sort((a, b) => {
      for (const sort of sorts as Array<{ property?: string; timestamp?: string; direction?: string }>) {
        const direction = sort.direction === "descending" ? -1 : 1;
        const key = (row: NotionPageRecord): PlainValue | number =>
          sort.timestamp === "created_time"
            ? row.createdAt
            : sort.timestamp === "last_edited_time"
              ? row.lastEditedAt
              : world.toPlain(row.properties[database.properties.find((p) => p.name === sort.property)?.name ?? ""]);
        const [left, right] = [JSON.stringify(key(a)), JSON.stringify(key(b))];
        if (left !== right) return (left < right ? -1 : 1) * direction;
      }
      return 0;
    });
  };

  // --- Search ---------------------------------------------------------------------------------

  endpoint("post", "/v1/search", "search", (_c, body) => {
    const query = typeof body.query === "string" ? body.query.toLowerCase() : "";
    const only = (body.filter as { value?: string } | undefined)?.value;
    const pages = only === "data_source" ? [] : store.pages.values().filter((page) => world.accessible(page.id));
    const databases =
      only === "page" ? [] : store.databases.values().filter((database) => world.accessible(database.id));
    const found = [
      ...pages
        .filter((page) => world.titleOf(page).toLowerCase().includes(query))
        .map((page) => ({ at: page.lastEditedAt, id: page.id, object: objects.page(page) as object })),
      ...databases
        .filter((database) => database.title.toLowerCase().includes(query))
        .map((database) => ({
          at: database.lastEditedAt,
          id: database.id,
          object: objects.dataSource(database) as object,
        })),
    ].sort((a, b) => b.at - a.at);
    const list = objects.list("page_or_data_source", found, bodyPaging(body), (entry) => entry.id);
    return {
      body: { ...list, results: list.results.map((entry) => entry.object) },
      sessions: list.results.map((entry) => sessionOf(entry.id)),
    };
  });

  // --- Comments -------------------------------------------------------------------------------

  endpoint("get", "/v1/comments", "comments.list", (c) => {
    const id = c.req.query("block_id");
    if (id === undefined)
      throw new NotionApiError(
        400,
        "validation_error",
        "query failed validation: query.block_id should be defined, instead was `undefined`.",
      );
    const { block, page } = world.visibleBlock(id);
    // The open discussions of the page itself, or of one block.
    const discussions = world
      .discussionsOf(page)
      .filter((discussion) => !discussion.resolved && discussion.block === (block?.id ?? null));
    const comments = discussions
      .flatMap((discussion) => world.commentsOf(discussion))
      .sort((a, b) => a.createdAt - b.createdAt);
    return {
      body: objects.list("comment", comments.map(objects.comment), paging(c), (comment) => comment.id),
      sessions: [sessionOf(page.id)],
    };
  });

  endpoint("get", "/v1/comments/:id", "comments.retrieve", (c) => {
    const id = param(c, "id");
    const comment = store.comments.find(id);
    if (!comment || !world.accessible(comment.page))
      throw new NotionApiError(404, "object_not_found", `Could not find comment with ID: ${id}.`);
    return { body: objects.comment(comment), sessions: [sessionOf(comment.id)] };
  });

  endpoint("post", "/v1/comments", "comments.create", (_c, body) => {
    const rich = world.richFromRequest(body.rich_text);
    if (typeof body.discussion_id === "string") {
      const discussion = store.discussions.find(body.discussion_id);
      if (!discussion || !world.accessible(discussion.page))
        throw new NotionApiError(404, "object_not_found", `Could not find discussion with ID: ${body.discussion_id}.`);
      const comment = world.commentAs(sessionOf(discussion.id), { discussion }, rich, bot());
      return { body: objects.comment(comment), sessions: [sessionOf(comment.id)] };
    }
    const parent = body.parent as { page_id?: string; block_id?: string } | undefined;
    const target = parent?.page_id ?? parent?.block_id;
    if (target === undefined)
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: body.parent or body.discussion_id should be defined.",
      );
    const { block, page } = world.visibleBlock(target);
    const comment = world.commentAs(sessionOf(page.id), block ? { block } : { page }, rich, bot());
    return { body: objects.comment(comment), sessions: [sessionOf(comment.id)] };
  });

  // Mounted under a path prefix, the app's own not-found would answer: this one is Notion's.
  api.all("*", (c) => c.json(errorBody(400, "invalid_request_url", "Invalid request URL."), 400));
  return api;
}
