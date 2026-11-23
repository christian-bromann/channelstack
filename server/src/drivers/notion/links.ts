import type { NotionDatabaseRecord, NotionPageRecord } from "./world.ts";

/** A Notion URL names a page by its title and its id without dashes: `/Roadmap-1a2b…`. */
const slug = (title: string, id: string) =>
  `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "Untitled"}-${id.replaceAll("-", "")}`;

/** Links into the fake workspace, where a person would open a page. */
export function notionLinks(apiUrl: () => string, titleOf: (page: NotionPageRecord) => string) {
  return {
    page: (page: NotionPageRecord) => `${apiUrl()}/${slug(titleOf(page), page.id)}`,
    database: (database: NotionDatabaseRecord) => `${apiUrl()}/${slug(database.title, database.id)}`,
  };
}

export type NotionLinks = ReturnType<typeof notionLinks>;
