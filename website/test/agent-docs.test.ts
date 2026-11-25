import { beforeAll, describe, expect, test } from "vitest";

import { type AgentPage, llmsFullTxt, llmsTxt, loadAgentDocs, searchFile } from "../plugins/agent-docs";
import worker, { type Env, pagePath, wantsMarkdown } from "../worker/index";

let pages: AgentPage[];
let files: Map<string, string>;

/** The Worker's assets: what the build writes, served from memory. */
const env: Env = {
  ASSETS: {
    async fetch(request) {
      const body = files.get(new URL(request.url).pathname);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  },
};

beforeAll(async () => {
  pages = await loadAgentDocs();
  files = new Map([
    ...pages.map((page): [string, string] => [page.markdownPath, page.markdown]),
    ["/llms.txt", llmsTxt(pages)],
    ["/llms-full.txt", llmsFullTxt(pages)],
    ["/docs-search.json", JSON.stringify(searchFile(pages))],
  ]);
});

const page = (path: string) => {
  const found = pages.find((candidate) => candidate.entry.path === path);
  if (!found) throw new Error(`no page ${path}`);
  return found.markdown;
};

describe("the Markdown pages", () => {
  test("every page starts with its title and keeps no MDX", () => {
    for (const { entry, markdown } of pages) {
      expect(markdown.split("\n")[0], entry.path).toMatch(/^# /);
      expect(markdown, entry.path).not.toMatch(/<(Example|CodeGroup|TerminalSession|RequestFlow|dl|dt)\b|\{\/\*/);
    }
  });

  test("an example is a code block in each language", () => {
    const markdown = page("/docs/guide/writing-tests");
    for (const title of ["TypeScript", "Python", "Rust"]) expect(markdown).toContain(`title="${title}"`);
    expect(markdown).not.toContain("@show:start");
  });

  test("a figure is its caption, and a definition list is a list", () => {
    expect(page("/docs/guide/how-it-works")).toContain("Each test gets its own session");
    expect(page("/docs/reference/matchers")).toMatch(/^- \*\*Subject\*\*: /m);
  });

  test("callouts keep GitHub's alert syntax, and site links are absolute", () => {
    const markdown = page("/docs/getting-started");
    expect(markdown).toMatch(/^> \[!NOTE\]$/m);
    expect(markdown).toContain("](https://channelstack.dev/docs/guide/connecting-your-agent)");
  });

  test("llms.txt lists every page's Markdown, by section", () => {
    const index = files.get("/llms.txt") ?? "";
    expect(index).toMatch(/^# channelstack\n\n> /);
    expect(index).toContain("## Reference: Tools");
    for (const { markdownPath } of pages) expect(index).toContain(`(https://channelstack.dev${markdownPath})`);
  });
});

describe("pagePath", () => {
  const known = new Map(
    ["/docs", "/docs/guide/live-mode"].map((path) => [path, { path, title: path, section: "Guide" }]),
  );

  test("takes a path, a URL, a slug or the Markdown's URL", () => {
    for (const input of [
      "/docs/guide/live-mode",
      "https://channelstack.dev/docs/guide/live-mode#credentials",
      "guide/live-mode",
      "/docs/guide/live-mode.md",
      "/docs/guide/live-mode/",
    ]) {
      expect(pagePath(input, known), input).toBe("/docs/guide/live-mode");
    }
    expect(pagePath("/docs", known)).toBe("/docs");
  });

  test("refuses anything that isn't a listed page", () => {
    for (const input of ["/docs/../llms-full", "/docs-search", "https://example.com/docs", "/docs/guide/nope"]) {
      expect(pagePath(input, known), input).toBeUndefined();
    }
  });
});

describe("the MCP server", () => {
  let id = 0;
  const call = async (method: string, params: object) => {
    const response = await worker.fetch(
      new Request("https://channelstack.dev/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
      env,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    return (await response.json()) as {
      result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
    };
  };
  const tool = async (name: string, args: object) => (await call("tools/call", { name, arguments: args })).result;

  test("lists its three read-only tools", async () => {
    const { result } = await call("tools/list", {});
    expect(result.tools?.map((candidate) => candidate.name).sort()).toEqual(["list_docs", "read_doc", "search_docs"]);
  });

  test("search_docs finds the section, with its URL", async () => {
    const result = await tool("search_docs", { query: "toHaveReplyFrom", limit: 3 });
    expect(result.content?.[0]?.text).toContain("https://channelstack.dev/docs/reference/matchers#tohavereplyfrom");
  });

  test("read_doc reads a page by its URL", async () => {
    const result = await tool("read_doc", { page: "https://channelstack.dev/docs/guide/ci" });
    expect(result.content?.[0]?.text).toMatch(/^# Running in CI/);
  });

  test("read_doc refuses what isn't a page", async () => {
    const result = await tool("read_doc", { page: "/docs/../llms-full" });
    expect(result.isError).toBe(true);
  });

  test("list_docs is llms.txt", async () => {
    const result = await tool("list_docs", {});
    expect(result.content?.[0]?.text).toBe(files.get("/llms.txt"));
  });

  test("a GET is refused: there's no stream without a session", async () => {
    const response = await worker.fetch(new Request("https://channelstack.dev/mcp"), env);
    expect(response.status).toBe(405);
  });

  test("a docs page asked for as Markdown is its Markdown", async () => {
    const asMarkdown = await worker.fetch(
      new Request("https://channelstack.dev/docs/guide/ci", { headers: { Accept: "text/markdown" } }),
      env,
    );
    expect(await asMarkdown.text()).toBe(files.get("/docs/guide/ci.md"));
    expect(asMarkdown.headers.get("Vary")).toBe("Accept");
  });

  test("other paths are the static assets", async () => {
    const response = await worker.fetch(new Request("https://channelstack.dev/llms.txt"), env);
    expect(await response.text()).toBe(files.get("/llms.txt"));
  });
});

describe("wantsMarkdown", () => {
  test("a request that names Markdown at least as high as HTML", () => {
    expect(wantsMarkdown("text/markdown")).toBe(true);
    expect(wantsMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
    expect(wantsMarkdown("text/markdown, */*")).toBe(true);
  });

  test("a browser, or a request that prefers HTML", () => {
    expect(wantsMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(wantsMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
    expect(wantsMarkdown("text/markdown;q=0")).toBe(false);
    expect(wantsMarkdown(null)).toBe(false);
  });
});
