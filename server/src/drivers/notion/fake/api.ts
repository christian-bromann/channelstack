import type { Context, Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { NotionApiError, pagingOf } from "../errors.ts";
import { NOTION_IDS } from "../ids.ts";
import { NOTION_API_VERSION } from "../payloads.ts";
import type { NotionBlockRecord, NotionCapability, NotionDatabaseRecord, NotionPageRecord } from "../world.ts";
import type { FakeNotionWorld, PlainValue } from "./world.ts";

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

/**
 * Notion's REST API, as the integration sees it (`@notionhq/client` at API version `2025-09-03`):
 * the integration's token, and only what it is connected to. Each call is on record for the test
 * sessions whose objects it read or changed, by the client's method name (`comments.create`).
 */
export function createNotionApi(context: DriverContext, world: FakeNotionWorld): Hono {
  const { store, objects } = world;
  const bot = () => store.bot.id;
  const requestId = () => context.ids.next(NOTION_IDS.uuid);

  const errorBody = (status: number, code: string, message: string) => ({
    object: "error",
    status,
    code,
    message,
    request_id: requestId(),
  });
  const errorAnswer = (status: number, code: string, message: string): RestAnswer => ({
    body: errorBody(status, code, message),
    sessions: [],
    status,
  });

  /** A block as the API shows it: a `child_page` has its page's current title. */
  const blockObject = (block: NotionBlockRecord) => objects.block({ ...block, data: world.dataOf(block) });
  const sessionOf = (id: string) => store.sessionOf(id);

  const { endpoint, finish } = restApi(context, {
    driver: "notion",
    authorize(c, operation) {
      const token = bearerFrom(c.req.header("authorization")) ?? "";
      if (token === "" || !constantTimeEqual(token, context.secret("token"))) {
        return errorAnswer(401, "unauthorized", "API token is invalid.");
      }
      const version = c.req.header("notion-version");
      if (version === undefined) {
        return errorAnswer(
          400,
          "missing_version",
          "Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.",
        );
      }
      if (!VERSIONS.includes(version)) {
        return errorAnswer(
          400,
          "validation_error",
          `Notion-Version header failed validation: ${version} is not a supported version.`,
        );
      }
      const needs = NEEDS[operation];
      if (needs && !store.bot.capabilities.includes(needs)) {
        return errorAnswer(403, "restricted_resource", "Insufficient permissions for this endpoint.");
      }
      return undefined;
    },
    refusal: (error) =>
      error instanceof NotionApiError ? errorAnswer(error.status, error.code, error.message) : undefined,
    invalidJson: () => errorAnswer(400, "invalid_json", "Error parsing JSON body."),
    notFound: () => errorAnswer(400, "invalid_request_url", "Invalid request URL."),
    // Every answer of Notion's has its request's id, not only an error (found by the shape differ).
    decorate(answer) {
      const status = answer.status ?? 200;
      if (status >= 400 || typeof answer.body !== "object" || answer.body === null || Array.isArray(answer.body)) {
        return answer;
      }
      return { ...answer, body: { ...(answer.body as object), request_id: requestId() } };
    },
  });

  const paging = (c: Context) =>
    pagingOf({
      start_cursor: c.req.query("start_cursor"),
      page_size: c.req.query("page_size") === undefined ? undefined : Number(c.req.query("page_size")),
    });
  const bodyPaging = (body: Record<string, unknown>) =>
    pagingOf({ start_cursor: body.start_cursor, page_size: body.page_size });

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

  /**
   * Does a value pass one condition of a filter (`{ equals: "Done" }`)? Text compares without case
   * for `contains` and its kin, as Notion's do; numbers and dates compare as numbers and dates. A
   * list (multi-select, people, relations) contains or doesn't contain the operand.
   */
  const passes = (value: PlainValue | number, operator: string, operand: unknown): boolean => {
    if (operator === "is_empty") return isEmpty(value) === (operand !== false);
    if (operator === "is_not_empty") return isEmpty(value) !== (operand !== false);
    if (Array.isArray(value)) {
      const has = value.includes(String(operand));
      if (operator === "contains" || operator === "equals") return has;
      if (operator === "does_not_contain" || operator === "does_not_equal") return !has;
      throw unsupported(operator);
    }
    if (value === null) return operator === "does_not_equal" || operator === "does_not_contain";
    if (typeof value === "number") {
      const wanted = Number(operand);
      const compare: Record<string, boolean> = {
        equals: value === wanted,
        does_not_equal: value !== wanted,
        greater_than: value > wanted,
        less_than: value < wanted,
        greater_than_or_equal_to: value >= wanted,
        less_than_or_equal_to: value <= wanted,
      };
      if (!(operator in compare)) throw unsupported(operator);
      return compare[operator] === true;
    }
    if (typeof value === "boolean") {
      if (operator === "equals") return value === operand;
      if (operator === "does_not_equal") return value !== operand;
      throw unsupported(operator);
    }
    if (typeof value === "object") {
      const [at, wanted] = [Date.parse(value.start), Date.parse(String(operand))];
      const compare: Record<string, boolean> = {
        equals: at === wanted,
        before: at < wanted,
        after: at > wanted,
        on_or_before: at <= wanted,
        on_or_after: at >= wanted,
      };
      if (!(operator in compare)) throw unsupported(operator);
      return compare[operator] === true;
    }
    const [text, wanted] = [value.toLowerCase(), String(operand).toLowerCase()];
    switch (operator) {
      case "equals":
        return value === String(operand);
      case "does_not_equal":
        return value !== String(operand);
      case "contains":
        return text.includes(wanted);
      case "does_not_contain":
        return !text.includes(wanted);
      case "starts_with":
        return text.startsWith(wanted);
      case "ends_with":
        return text.endsWith(wanted);
      default:
        throw unsupported(operator);
    }
  };
  const isEmpty = (value: PlainValue | number) =>
    value === null || value === "" || (Array.isArray(value) && value.length === 0);
  const unsupported = (operator: string) =>
    new NotionApiError(
      400,
      "validation_error",
      `body failed validation: ${operator} is not a filter condition for this property`,
    );

  /** Does a row pass a data source filter: a property or timestamp condition, or `and` / `or` of them. */
  const matches = (database: NotionDatabaseRecord, row: NotionPageRecord, filter: unknown): boolean => {
    if (filter === undefined || filter === null) return true;
    const input = filter as Record<string, unknown>;
    if (Array.isArray(input.and)) return input.and.every((inner) => matches(database, row, inner));
    if (Array.isArray(input.or)) return input.or.some((inner) => matches(database, row, inner));
    const condition = (key: string) => Object.entries((input[key] ?? {}) as Record<string, unknown>)[0];
    if (input.timestamp === "created_time" || input.timestamp === "last_edited_time") {
      const [operator, operand] = condition(input.timestamp) ?? [];
      if (operator === undefined) throw unsupported("an empty condition");
      const at = input.timestamp === "created_time" ? row.createdAt : row.lastEditedAt;
      return passes({ start: new Date(at).toISOString() }, operator, operand);
    }
    if (typeof input.property !== "string")
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: a filter names a property or a timestamp",
      );
    const property = database.properties.find(
      (candidate) => candidate.name === input.property || candidate.id === input.property,
    );
    if (!property)
      throw new NotionApiError(400, "validation_error", `Could not find property with name or id: ${input.property}`);
    const [operator, operand] = condition(property.type) ?? [];
    if (operator === undefined)
      throw new NotionApiError(
        400,
        "validation_error",
        `body failed validation: ${property.name} is filtered as ${property.type}`,
      );
    return passes(world.toPlain(row.properties[property.name]), operator, operand);
  };

  /** Rows in the order of `sorts`: numbers and times as numbers, text by its letters, empty values last. */
  const sorted = (database: NotionDatabaseRecord, rows: NotionPageRecord[], sorts: unknown): NotionPageRecord[] => {
    if (!Array.isArray(sorts)) return rows;
    const key = (row: NotionPageRecord, sort: { property?: string; timestamp?: string }): string | number | null => {
      if (sort.timestamp === "created_time") return row.createdAt;
      if (sort.timestamp === "last_edited_time") return row.lastEditedAt;
      const property = database.properties.find(
        (candidate) => candidate.name === sort.property || candidate.id === sort.property,
      );
      if (!property)
        throw new NotionApiError(
          400,
          "validation_error",
          `Could not find sort property with name or id: ${sort.property}`,
        );
      const value = world.toPlain(row.properties[property.name]);
      if (value === null || typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (Array.isArray(value)) return value.join(", ") || null;
      return typeof value === "object" ? Date.parse(value.start) : value || null;
    };
    return [...rows].sort((a, b) => {
      for (const sort of sorts as Array<{ property?: string; timestamp?: string; direction?: string }>) {
        const [left, right] = [key(a, sort), key(b, sort)];
        if (left === right) continue;
        if (left === null) return 1;
        if (right === null) return -1;
        const order =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return sort.direction === "descending" ? -order : order;
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
  return finish();
}
