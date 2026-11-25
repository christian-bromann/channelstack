/**
 * The docs' search index, shared by the build that writes it (plugins/agent-docs.ts) and the MCP
 * server that loads it (worker/index.ts). Both must use these options, or the loaded index won't
 * match.
 */
import MiniSearch, { type Options } from "minisearch";

/** One searchable part of a page: its opening, or the text under one H2 or H3. */
export interface DocChunk {
  /** `/docs/guide/live-mode#credentials`: the page's path, and the heading's id when there is one. */
  id: string;
  /** The page's title. */
  page: string;
  /** The heading's text; the page's title for its opening. */
  heading: string;
  /** The sidebar section the page is in. */
  section: string;
  /** All of the part's text, indexed and not stored. */
  text: string;
  /** The part's first words, returned with a hit. */
  excerpt: string;
}

/** One page, as list_docs and read_doc know it. */
export interface DocPageInfo {
  /** `/docs/guide/live-mode`. The page's Markdown is at this path plus `.md`. */
  path: string;
  title: string;
  section: string;
  description?: string;
}

/** What the build writes to /docs-search.json. */
export interface SearchFile {
  pages: DocPageInfo[];
  index: unknown;
}

export const SEARCH_OPTIONS: Options<DocChunk> = {
  fields: ["page", "heading", "text"],
  storeFields: ["page", "heading", "section", "excerpt"],
  searchOptions: { boost: { heading: 3, page: 2 }, prefix: true, fuzzy: 0.15 },
};

export function buildIndex(chunks: DocChunk[]): MiniSearch<DocChunk> {
  const search = new MiniSearch<DocChunk>(SEARCH_OPTIONS);
  search.addAll(chunks);
  return search;
}

export function loadIndex(file: SearchFile): MiniSearch<DocChunk> {
  return MiniSearch.loadJS(file.index as Parameters<typeof MiniSearch.loadJS>[0], SEARCH_OPTIONS);
}
