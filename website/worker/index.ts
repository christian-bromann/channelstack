/**
 * channelstack.dev's Worker. Everything is static assets except /mcp: an MCP server over
 * Streamable HTTP that searches and reads the docs, for coding agents.
 *
 * It's stateless and read-only: each POST gets a fresh server, answers with JSON and keeps no
 * session. It only ever reads what the build wrote (plugins/agent-docs.ts): /llms.txt,
 * /docs-search.json, and a page's Markdown when the page is one the index lists, so a tool
 * argument never becomes an arbitrary fetch.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type MiniSearch from "minisearch";
import { z } from "zod";

import { type DocChunk, type DocPageInfo, loadIndex, type SearchFile } from "./search";

/** The static assets binding (wrangler.jsonc). */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const SITE = "https://channelstack.dev";
const MCP_PATH = "/mcp";

/** Anyone may call it from a browser (the MCP Inspector, a web-based agent): it's public and read-only. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const INSTRUCTIONS = `channelstack's documentation. channelstack is a test harness for apps and AI agents that live in Slack, GitHub, Linear and Notion: one server fakes those platforms, tests act as people and check what a person would see.

Use search_docs to find the page and section for a question, then read_doc to read the page. list_docs lists every page by section.`;

interface Docs {
  search: MiniSearch<DocChunk>;
  pages: Map<string, DocPageInfo>;
}

/** The index, loaded once per isolate. A failed load is retried on the next request. */
let docs: Promise<Docs> | undefined;

function loadDocs(env: Env, origin: string): Promise<Docs> {
  docs ??= (async () => {
    const response = await env.ASSETS.fetch(new Request(`${origin}/docs-search.json`));
    if (!response.ok) throw new Error(`the search index answered ${response.status}`);
    const file = (await response.json()) as SearchFile;
    return { search: loadIndex(file), pages: new Map(file.pages.map((page) => [page.path, page])) };
  })().catch((error: unknown) => {
    docs = undefined;
    throw error;
  });
  return docs;
}

/**
 * A page's path from what an agent passes: `/docs/guide/live-mode`, the full URL, its `.md`, with
 * or without a `#heading` or trailing slash. Undefined unless it's a page the index lists.
 */
export function pagePath(input: string, pages: ReadonlyMap<string, DocPageInfo>): string | undefined {
  let path = input.trim();
  if (path.startsWith(SITE)) path = path.slice(SITE.length);
  path = path
    .replace(/[?#].*$/, "")
    .replace(/\.md$/, "")
    .replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/docs/${path.replace(/^docs\/?/, "")}`.replace(/\/+$/, "");
  return pages.has(path) ? path : undefined;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

function server(env: Env, origin: string): McpServer {
  const mcp = new McpServer({ name: "channelstack-docs", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  mcp.registerTool(
    "search_docs",
    {
      title: "Search the channelstack docs",
      description:
        "Search channelstack's docs (guides, platform pages, the API reference, matchers, CLI) for a question or a name, such as `toHaveReplyFrom`, `live mode credentials` or `Slack retries`. Returns the best sections, each with its page, its URL and its opening words.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Words or an API name to look for"),
        limit: z.number().int().min(1).max(10).optional().describe("How many sections to return (default 5)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const { search } = await loadDocs(env, origin);
      const hits = search.search(query).slice(0, limit ?? 5);
      if (hits.length === 0) return text(`Nothing in the docs matches "${query}". Try other words, or list_docs.`);
      return text(
        hits
          .map((hit, index) => {
            const title = hit.heading === hit.page ? hit.page : `${hit.page} › ${hit.heading}`;
            return `${index + 1}. ${title} (${hit.section})\n   ${SITE}${hit.id}\n   ${hit.excerpt}`;
          })
          .join("\n\n"),
      );
    },
  );

  mcp.registerTool(
    "read_doc",
    {
      title: "Read a channelstack docs page",
      description:
        "Read one page of channelstack's docs as Markdown, with every code example in TypeScript, Python and Rust. Pass a path or URL from search_docs or list_docs, such as `/docs/guide/live-mode`.",
      inputSchema: {
        page: z.string().min(1).max(300).describe("The page's path or URL, such as /docs/reference/matchers"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ page }) => {
      const { pages } = await loadDocs(env, origin);
      const path = pagePath(page, pages);
      if (!path) return failure(`There's no docs page at "${page}". list_docs lists every page.`);
      const response = await env.ASSETS.fetch(new Request(`${origin}${path}.md`));
      if (!response.ok) return failure(`${path} couldn't be read (${response.status}).`);
      return text(await response.text());
    },
  );

  mcp.registerTool(
    "list_docs",
    {
      title: "List the channelstack docs",
      description:
        "List every page of channelstack's docs by section, each with its URL and what it covers (llms.txt).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const response = await env.ASSETS.fetch(new Request(`${origin}/llms.txt`));
      if (!response.ok) return failure(`The page list couldn't be read (${response.status}).`);
      return text(await response.text());
    },
  );

  return mcp;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Without sessions there's no stream to open (GET) or session to end (DELETE).
  if (request.method !== "POST") {
    return new Response(
      "channelstack's docs over MCP (Streamable HTTP). Add this URL to your agent as a remote MCP server.\n",
      { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS", "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcp = server(env, new URL(request.url).origin);
  await mcp.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === MCP_PATH || pathname === `${MCP_PATH}/`) return handleMcp(request, env);
    return env.ASSETS.fetch(request);
  },
};
