/**
 * The objects Notion's API answers with, built from the fake's records. Each builder is typed by
 * `@notionhq/client`'s own response types, so a field Notion has and the fake forgot is a type error.
 */
import type {
  BlockObjectResponse,
  CommentObjectResponse,
  DatabaseObjectResponse,
  DataSourceObjectResponse,
  PageObjectResponse,
  ParagraphBlockObjectResponse,
  UserObjectResponse,
} from "@notionhq/client";

import { iso } from "../../core/clock/index.ts";
import { NotionApiError } from "./errors.ts";
import type { NotionLinks } from "./links.ts";
import { textItem } from "./rich-text.ts";
import type {
  NotionBlockRecord,
  NotionBotRecord,
  NotionCommentRecord,
  NotionDatabaseRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionParent,
  NotionPropertyRecord,
  NotionUserRecord,
  NotionValue,
  NotionWorkspaceRecord,
} from "./world.ts";

const partialUser = (id: string) => ({ object: "user" as const, id });

type PropertyValue = PageObjectResponse["properties"][string];
type DataSourceProperty = DataSourceObjectResponse["properties"][string];

/** What a paragraph has that a request may leave out: its icon, none unless one is set. */
const PARAGRAPH: Pick<ParagraphBlockObjectResponse["paragraph"], "icon"> = { icon: null };

export interface NotionObjectsDeps {
  links: NotionLinks;
  workspace: () => NotionWorkspaceRecord;
  bot: () => NotionBotRecord;
  /** A person or the bot by id, for a mention or a `people` value. */
  user: (id: string) => NotionUserRecord | NotionBotRecord | undefined;
  database: (id: string) => NotionDatabaseRecord;
  discussion: (id: string) => NotionDiscussionRecord;
}

export function notionObjects(deps: NotionObjectsDeps) {
  const isBot = (record: NotionUserRecord | NotionBotRecord): record is NotionBotRecord => "integrationId" in record;

  const user = (record: NotionUserRecord | NotionBotRecord, withEmail: boolean): UserObjectResponse =>
    isBot(record)
      ? {
          object: "user",
          id: record.id,
          name: record.name,
          avatar_url: null,
          type: "bot",
          bot: {
            owner: { type: "workspace", workspace: true },
            workspace_name: deps.workspace().name,
            workspace_id: deps.workspace().id,
            workspace_limits: { max_file_upload_size_in_bytes: 5_368_709_120 },
          },
        }
      : {
          object: "user",
          id: record.id,
          name: record.name,
          avatar_url: record.avatarUrl,
          type: "person",
          person: withEmail ? { email: record.email } : {},
        };

  /** Where a page or database is, as the API names its parent. */
  const parent = (where: NotionParent) => {
    switch (where.type) {
      case "workspace":
        return { type: "workspace" as const, workspace: true as const };
      case "page_id":
        return { type: "page_id" as const, page_id: where.id };
      case "database_id":
        return { type: "data_source_id" as const, data_source_id: where.dataSource, database_id: where.id };
    }
  };

  /** A page's title property, the one a page outside a database has. */
  const titleProperty = (page: NotionPageRecord): PropertyValue => {
    const value = page.properties.title;
    return { id: "title", type: "title", title: value?.type === "title" ? value.rich : [] };
  };

  const propertyValue = (schema: NotionPropertyRecord, value: NotionValue | undefined): PropertyValue => {
    const id = schema.id;
    const option = (name: string | null | undefined) => {
      const found = schema.options.find((candidate) => candidate.name === name);
      return found ? { id: found.id, name: found.name, color: found.color as "default" } : null;
    };
    switch (schema.type) {
      case "title":
        return { id, type: "title", title: value?.type === "title" ? value.rich : [] };
      case "rich_text":
        return { id, type: "rich_text", rich_text: value?.type === "rich_text" ? value.rich : [] };
      case "number":
        return { id, type: "number", number: value?.type === "number" ? value.value : null };
      case "checkbox":
        return { id, type: "checkbox", checkbox: value?.type === "checkbox" ? value.value : false };
      case "select":
        return { id, type: "select", select: option(value?.type === "select" ? value.option : null) };
      case "status":
        return { id, type: "status", status: option(value?.type === "status" ? value.option : null) };
      case "multi_select":
        return {
          id,
          type: "multi_select",
          multi_select: (value?.type === "multi_select" ? value.options : [])
            .map(option)
            .filter((entry) => entry !== null),
        };
      case "date":
        return {
          id,
          type: "date",
          date: value?.type === "date" && value.value ? { ...value.value, time_zone: null } : null,
        };
      case "people":
        return { id, type: "people", people: (value?.type === "people" ? value.ids : []).map(partialUser) };
      case "relation":
        return {
          id,
          type: "relation",
          relation: (value?.type === "relation" ? value.ids : []).map((page) => ({ id: page })),
        };
      case "url":
        return { id, type: "url", url: value?.type === "url" ? value.value : null };
      case "email":
        return { id, type: "email", email: value?.type === "email" ? value.value : null };
    }
  };

  const page = (record: NotionPageRecord): PageObjectResponse => {
    const database = record.parent.type === "database_id" ? deps.database(record.parent.id) : undefined;
    const properties: PageObjectResponse["properties"] = database
      ? Object.fromEntries(
          database.properties.map((schema) => [schema.name, propertyValue(schema, record.properties[schema.name])]),
        )
      : { title: titleProperty(record) };
    return {
      object: "page",
      id: record.id,
      created_time: iso(record.createdAt),
      last_edited_time: iso(record.lastEditedAt),
      in_trash: record.inTrash,
      archived: record.inTrash,
      is_archived: record.inTrash,
      is_locked: false,
      url: deps.links.page(record),
      public_url: null,
      parent: parent(record.parent),
      properties,
      icon: record.icon === null ? null : { type: "emoji", emoji: record.icon as "📄" },
      cover: null,
      created_by: partialUser(record.createdBy),
      last_edited_by: partialUser(record.lastEditedBy),
    };
  };

  const block = (record: NotionBlockRecord): BlockObjectResponse =>
    ({
      object: "block",
      id: record.id,
      parent:
        record.parent.type === "page_id"
          ? { type: "page_id", page_id: record.parent.id }
          : { type: "block_id", block_id: record.parent.id },
      created_time: iso(record.createdAt),
      last_edited_time: iso(record.lastEditedAt),
      created_by: partialUser(record.createdBy),
      last_edited_by: partialUser(record.lastEditedBy),
      has_children: record.children.length > 0,
      in_trash: record.inTrash,
      archived: record.inTrash,
      type: record.type,
      [record.type]: record.type === "paragraph" ? { ...PARAGRAPH, ...record.data } : record.data,
    }) as BlockObjectResponse;

  const dataSourceProperty = (schema: NotionPropertyRecord): DataSourceProperty => {
    const base = { id: schema.id, name: schema.name, description: null };
    const options = schema.options.map((option) => ({
      ...option,
      color: option.color as "default",
      description: null,
    }));
    switch (schema.type) {
      case "select":
        return { ...base, type: "select", select: { options } };
      case "multi_select":
        return { ...base, type: "multi_select", multi_select: { options } };
      case "status":
        return { ...base, type: "status", status: { default_option: options[0]?.id ?? null, options, groups: [] } };
      case "number":
        return { ...base, type: "number", number: { format: "number" } };
      case "relation":
        return {
          ...base,
          type: "relation",
          relation: {
            type: "single_property",
            single_property: {},
            database_id: schema.relation ?? "",
            data_source_id: deps.database(schema.relation ?? "").dataSource,
            limit: null,
          },
        };
      default:
        return { ...base, type: schema.type, [schema.type]: {} } as DataSourceProperty;
    }
  };

  const database = (record: NotionDatabaseRecord): DatabaseObjectResponse => ({
    object: "database",
    id: record.id,
    title: [textItem(record.title)],
    description: [],
    parent:
      record.parent.type === "page_id"
        ? { type: "page_id", page_id: record.parent.id }
        : { type: "workspace", workspace: true },
    is_inline: false,
    database_type: null,
    in_trash: record.inTrash,
    archived: record.inTrash,
    is_locked: false,
    show_data_source_title: false,
    created_time: iso(record.createdAt),
    last_edited_time: iso(record.lastEditedAt),
    data_sources: [{ id: record.dataSource, name: record.title }],
    icon: null,
    cover: null,
    url: deps.links.database(record),
    public_url: null,
  });

  const dataSource = (record: NotionDatabaseRecord): DataSourceObjectResponse => ({
    object: "data_source",
    id: record.dataSource,
    title: [textItem(record.title)],
    description: [],
    parent: { type: "database_id", database_id: record.id },
    database_type: null,
    database_parent:
      record.parent.type === "page_id"
        ? { type: "page_id", page_id: record.parent.id }
        : { type: "workspace", workspace: true },
    is_inline: false,
    in_trash: record.inTrash,
    archived: record.inTrash,
    created_time: iso(record.createdAt),
    last_edited_time: iso(record.lastEditedAt),
    created_by: partialUser(record.createdBy),
    last_edited_by: partialUser(record.createdBy),
    properties: Object.fromEntries(record.properties.map((schema) => [schema.name, dataSourceProperty(schema)])),
    icon: null,
    cover: null,
    url: deps.links.database(record),
    public_url: null,
  });

  const comment = (record: NotionCommentRecord): CommentObjectResponse => {
    const discussion = deps.discussion(record.discussion);
    const author = deps.user(record.createdBy);
    return {
      object: "comment",
      id: record.id,
      parent:
        discussion.block === null
          ? { type: "page_id", page_id: discussion.page }
          : { type: "block_id", block_id: discussion.block },
      discussion_id: discussion.id,
      created_time: iso(record.createdAt),
      last_edited_time: iso(record.lastEditedAt),
      created_by: partialUser(record.createdBy),
      rich_text: record.rich,
      display_name: {
        type: author && isBot(author) ? "integration" : "user",
        resolved_name: author?.name ?? null,
      },
      original_content_deleted: false,
      has_pending_attachments: false,
    };
  };

  /** One page of a paginated list, as every list endpoint answers. */
  const list = <T>(
    type: string,
    items: readonly T[],
    query: { start_cursor?: string | undefined; page_size?: number | undefined },
    idOf: (item: T) => string,
  ) => {
    const size = query.page_size ?? 100;
    const start = query.start_cursor ? items.findIndex((item) => idOf(item) === query.start_cursor) : 0;
    // A cursor that names nothing in the list (it was deleted, or never was) is refused, never page one again.
    if (start === -1)
      throw new NotionApiError(
        400,
        "validation_error",
        "body failed validation: start_cursor is not a cursor of this list.",
      );
    const results = items.slice(start, start + size);
    const next = items[start + size];
    return {
      object: "list" as const,
      results,
      next_cursor: next === undefined ? null : idOf(next),
      has_more: next !== undefined,
      type,
      [type]: {},
      request_id: "",
    };
  };

  return { user, page, block, database, dataSource, comment, propertyValue, list, parent };
}

export type NotionObjects = ReturnType<typeof notionObjects>;
