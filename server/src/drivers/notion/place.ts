import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/** Where the message a delivery tells the agent about is (a Notion integration webhook: its first author, the page, the discussion, and the comment): what a model call answering it is about. */
export const notionPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["authors.0.id"],
    conversation: ["data.page_id", "entity.id"],
    thread: ["data.discussion_id"],
    message: ["entity.id"],
  });
