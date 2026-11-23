/**
 * The Notion fake's records: what the workspace holds. They are the fake's own shapes; the API
 * objects Notion answers with are built from them (`objects.ts`), and so are webhooks (`payloads.ts`).
 */
import type { RichTextItem } from "./rich-text.ts";

export interface NotionWorkspaceRecord {
  id: string;
  name: string;
}

/** The agent's integration and its bot user: one per workspace. */
export interface NotionBotRecord {
  /** The bot user's id: who the integration acts as. */
  id: string;
  /** The integration's own id, as webhooks name it (`integration_id`). */
  integrationId: string;
  /** The webhook subscription the agent receives events through. */
  subscriptionId: string;
  name: string;
  events: readonly string[];
  capabilities: readonly NotionCapability[];
}

export type NotionCapability =
  "read_content" | "update_content" | "insert_content" | "read_comments" | "insert_comments" | "read_user_info";

export interface NotionUserRecord {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  /** A test gave it this id: it is free again when the session closes. */
  fixedId: boolean;
}

/** Where a page or a database lives. */
export type NotionParent =
  { type: "workspace" } | { type: "page_id"; id: string } | { type: "database_id"; id: string; dataSource: string };

export interface NotionPageRecord {
  id: string;
  parent: NotionParent;
  /** Property values by property name. A page outside a database has one: `title`. */
  properties: Record<string, NotionValue>;
  icon: string | null;
  /** Top-level blocks, in order. */
  children: string[];
  /** Integrations connected to this page itself (inherited ones are found through the parent). */
  connections: string[];
  createdBy: string;
  lastEditedBy: string;
  createdAt: number;
  lastEditedAt: number;
  inTrash: boolean;
}

/** A property's value as the fake keeps it: names for options, ids for people and pages. */
export type NotionValue =
  | { type: "title" | "rich_text"; rich: RichTextItem[] }
  | { type: "number"; value: number | null }
  | { type: "checkbox"; value: boolean }
  | { type: "select" | "status"; option: string | null }
  | { type: "multi_select"; options: string[] }
  | { type: "date"; value: { start: string; end: string | null } | null }
  | { type: "people" | "relation"; ids: string[] }
  | { type: "url" | "email"; value: string | null };

export type NotionPropertyType = NotionValue["type"];

interface NotionOption {
  id: string;
  name: string;
  color: string;
}

export interface NotionPropertyRecord {
  id: string;
  name: string;
  type: NotionPropertyType;
  /** For `select`, `multi_select` and `status`. */
  options: NotionOption[];
  /** For `relation`: the database it points to. */
  relation?: string;
}

/** A database and its one data source (API version `2025-09-03` splits them). */
export interface NotionDatabaseRecord {
  id: string;
  dataSource: string;
  parent: NotionParent;
  title: string;
  /** The schema, by property name, in the order it was given. */
  properties: NotionPropertyRecord[];
  connections: string[];
  createdBy: string;
  createdAt: number;
  lastEditedAt: number;
  inTrash: boolean;
}

export interface NotionBlockRecord {
  id: string;
  /** The page the block is on, however deep. */
  page: string;
  /** Its direct parent: the page, or the block it is nested in. */
  parent: { type: "page_id" | "block_id"; id: string };
  type: string;
  /** The type's own object, as the API has it under the type's name (`{ rich_text, color }`). */
  data: Record<string, unknown>;
  children: string[];
  createdBy: string;
  lastEditedBy: string;
  createdAt: number;
  lastEditedAt: number;
  inTrash: boolean;
}

/** A discussion: on the page, or on a block (the text it is anchored to). */
export interface NotionDiscussionRecord {
  id: string;
  page: string;
  block: string | null;
  /** The anchored block's text when the discussion started. */
  anchor: string | null;
  resolved: boolean;
  createdAt: number;
}

export interface NotionCommentRecord {
  id: string;
  discussion: string;
  page: string;
  rich: RichTextItem[];
  createdBy: string;
  createdAt: number;
  lastEditedAt: number;
  /** The `comment.created` delivery, when the integration was told. */
  delivery: string | undefined;
}
