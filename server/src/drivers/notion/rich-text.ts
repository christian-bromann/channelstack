/**
 * Notion's rich text: an array of text runs and mentions, each with its plain text. The fake
 * keeps the API's own items, so what it answers is what it stored.
 */
import type { RichTextItemResponse } from "@notionhq/client";

export type RichTextItem = RichTextItemResponse;
export type Annotations = RichTextItem["annotations"];

const PLAIN: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

/** A run of text, with its marks and link. */
export function textItem(content: string, marks: Partial<Annotations> = {}, link: string | null = null): RichTextItem {
  return {
    type: "text",
    text: { content, link: link === null ? null : { url: link } },
    annotations: { ...PLAIN, ...marks },
    plain_text: content,
    href: link,
  };
}

/** A mention of a person or the integration's bot: `@Name` to whoever reads it. */
export function userMention(id: string, name: string): RichTextItem {
  return {
    type: "mention",
    mention: { type: "user", user: { object: "user", id } },
    annotations: { ...PLAIN },
    plain_text: `@${name}`,
    href: null,
  };
}

export const plainText = (rich: readonly RichTextItem[]): string => rich.map((item) => item.plain_text).join("");
