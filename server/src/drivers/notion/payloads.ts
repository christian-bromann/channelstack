/**
 * Notion's webhook events, typed by `@notionhq/client`'s own payload types. Events are sparse:
 * they name what changed and who changed it, and the agent reads the rest through the API.
 */
import type {
  CommentCreatedWebhookPayload,
  PageContentUpdatedWebhookPayload,
  PageCreatedWebhookPayload,
  PagePropertiesUpdatedWebhookPayload,
} from "@notionhq/client";

import type { NotionBotRecord, NotionWorkspaceRecord } from "./world.ts";

export const NOTION_API_VERSION = "2025-09-03";

type Payload =
  | CommentCreatedWebhookPayload
  | PageContentUpdatedWebhookPayload
  | PageCreatedWebhookPayload
  | PagePropertiesUpdatedWebhookPayload;
type Base = Omit<Payload, "type" | "entity" | "data">;
/** Where a page sits, as an event names it. */
export type EventParent = PageCreatedWebhookPayload["data"]["parent"];
export type Author = { id: string; type: "person" | "bot" };

export function notionPayloads(deps: { workspace: () => NotionWorkspaceRecord; bot: () => NotionBotRecord }) {
  const base = (id: string, atMs: number, authors: Author[]): Base => ({
    id,
    timestamp: new Date(atMs).toISOString(),
    workspace_id: deps.workspace().id,
    workspace_name: deps.workspace().name,
    subscription_id: deps.bot().subscriptionId,
    integration_id: deps.bot().integrationId,
    authors,
    accessible_by: [{ id: deps.bot().id, type: "bot" }],
    attempt_number: 1,
    api_version: NOTION_API_VERSION,
  });

  return {
    commentCreated: (
      id: string,
      atMs: number,
      authors: Author[],
      comment: { id: string; page: string; discussion: string; parent: CommentCreatedWebhookPayload["data"]["parent"] },
      type: "comment.created" | "comment.updated" | "comment.deleted" = "comment.created",
    ) =>
      ({
        ...base(id, atMs, authors),
        type,
        entity: { id: comment.id, type: "comment" },
        data: { page_id: comment.page, discussion_id: comment.discussion, parent: comment.parent },
      }) as CommentCreatedWebhookPayload,
    pageCreated: (id: string, atMs: number, authors: Author[], page: string, parent: EventParent) =>
      ({
        ...base(id, atMs, authors),
        type: "page.created",
        entity: { id: page, type: "page" },
        data: { parent },
      }) satisfies PageCreatedWebhookPayload,
    contentUpdated: (
      id: string,
      atMs: number,
      authors: Author[],
      page: string,
      parent: EventParent,
      blocks: string[],
    ) =>
      ({
        ...base(id, atMs, authors),
        type: "page.content_updated",
        entity: { id: page, type: "page" },
        data: { parent, updated_blocks: blocks.map((block) => ({ id: block, type: "block" as const })) },
      }) satisfies PageContentUpdatedWebhookPayload,
    propertiesUpdated: (
      id: string,
      atMs: number,
      authors: Author[],
      page: string,
      parent: EventParent,
      properties: string[],
    ) =>
      ({
        ...base(id, atMs, authors),
        type: "page.properties_updated",
        entity: { id: page, type: "page" },
        data: { parent, updated_properties: properties },
      }) satisfies PagePropertiesUpdatedWebhookPayload,
  };
}

/** Each attempt carries its number in the signed body. */
export const stampAttempt = (body: string, _atMs: number, attempt: number): string =>
  body.replace(/"attempt_number":\d+/, `"attempt_number":${attempt}`);
