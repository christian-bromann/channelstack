/**
 * The docs for agents: every page as plain Markdown at its path plus `.md`, /llms.txt (the index,
 * as llmstxt.org lays it out), /llms-full.txt (every page in one file) and /docs-search.json (the
 * index the MCP server at /mcp searches, worker/index.ts).
 *
 * The Markdown comes from the page's source, not its HTML: an `<Example>` becomes its three code
 * blocks, a `<CodeGroup>` its blocks, an animated figure its caption, and links point at
 * channelstack.dev. A component this file doesn't know fails the build, so a new one gets a
 * Markdown form before it ships.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Expression } from "estree";
import type { BlockContent, Code, List, Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import { toString as textOf } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { Plugin } from "vite";
import { parse as parseYaml } from "yaml";

import { FIGURE_CAPTIONS, type FigureName } from "../src/components/docs/figure-captions";
import { type DocEntry, type Frontmatter, toSections } from "../src/lib/docs";
import { EXAMPLE_LANGUAGES } from "../src/lib/examples";
import { SITE } from "../src/lib/site";
import { buildIndex, type DocChunk, type SearchFile } from "../worker/search";
import { parseSample } from "./samples-plugin";
import { headingIds } from "./slug";

const WEBSITE = new URL("..", import.meta.url).pathname;
const DOCS = join(WEBSITE, "docs");
const EXAMPLES = join(WEBSITE, "examples");

/** The MCP server's address, for llms.txt and the page menu. */
export const MCP_URL = `${SITE.url}/mcp`;

export interface AgentPage {
  entry: DocEntry;
  /** Where the Markdown is served: `/docs/guide/live-mode.md`. */
  markdownPath: string;
  markdown: string;
  chunks: DocChunk[];
}

/** Every docs page, as Markdown and search chunks, in the sidebar's order. */
export async function loadAgentDocs(): Promise<AgentPage[]> {
  const files = (await readdir(DOCS, { recursive: true }))
    .filter((file) => /\.mdx?$/.test(file) && !file.endsWith("README.md"))
    .sort();
  const parsed = new Map<string, { frontmatter: Frontmatter; tree: Root }>();
  for (const file of files) {
    // The keys look like the site's own (`../../docs/guide/live-mode.mdx`), which src/lib/docs.ts expects.
    parsed.set(`../../docs/${file}`, parse(await readFile(join(DOCS, file), "utf8"), file));
  }
  const sections = toSections(Object.fromEntries([...parsed].map(([key, page]) => [key, page.frontmatter])));
  const pages: AgentPage[] = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      const page = parsed.get(`../../docs/${entry.source.replace(/^website\/docs\//, "")}`);
      if (!page) throw new Error(`agent-docs: no source for ${entry.path}`);
      const tree = await toPlainMarkdown(page.tree, entry);
      pages.push({
        entry,
        markdownPath: `${entry.path}.md`,
        markdown: stringify(tree),
        chunks: chunksOf(tree, entry),
      });
    }
  }
  return pages;
}

function parse(source: string, file: string): { frontmatter: Frontmatter; tree: Root } {
  const tree = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter).use(remarkGfm).parse(source);
  const yaml = tree.children[0]?.type === "yaml" ? tree.children[0].value : "";
  const frontmatter = (parseYaml(yaml) ?? {}) as Frontmatter;
  if (!frontmatter.title) throw new Error(`agent-docs: website/docs/${file} has no title`);
  return { frontmatter, tree };
}

/** The page without MDX: components become Markdown, links absolute, frontmatter and comments gone. */
async function toPlainMarkdown(source: Root, entry: DocEntry): Promise<Root> {
  const tree = structuredClone(source);
  tree.children = await flow(tree.children, entry);
  if (tree.children[0]?.type !== "heading" || tree.children[0].depth !== 1) {
    tree.children.unshift({ type: "heading", depth: 1, children: [{ type: "text", value: entry.title }] });
  }
  return tree;
}

async function flow(nodes: RootContent[], entry: DocEntry): Promise<RootContent[]> {
  const out: RootContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "yaml":
      case "mdxjsEsm":
      case "mdxFlowExpression":
        break;
      case "mdxJsxFlowElement":
        out.push(...(await component(node, entry)));
        break;
      default:
        if ("children" in node) {
          (node as { children: RootContent[] }).children = await flow(node.children as RootContent[], entry);
        }
        if (node.type === "mdxTextExpression") break;
        if (node.type === "mdxJsxTextElement") {
          // `<code>` stays code; any other inline element is its text.
          if (node.name === "code") out.push({ type: "inlineCode", value: textOf(node) });
          else out.push(...(node.children as RootContent[]));
          break;
        }
        if (node.type === "link" && node.url.startsWith("/")) node.url = SITE.url + node.url;
        out.push(node);
    }
  }
  return out;
}

async function component(node: MdxJsxFlowElement, entry: DocEntry): Promise<RootContent[]> {
  const where = `${entry.source}: <${node.name}>`;
  if (node.name === "CodeGroup") return flow(node.children, entry);
  if (node.name === "dl") return [definitions(node)];
  if (node.name === "Example") {
    const id = attribute(node, "id");
    if (typeof id !== "string") throw new Error(`${where} needs an id`);
    return Promise.all(
      EXAMPLE_LANGUAGES.map(async ({ title, lang, file }): Promise<Code> => {
        const { code } = parseSample(await readFile(join(EXAMPLES, file(id)), "utf8"));
        return { type: "code", lang, meta: `title="${title}"`, value: code };
      }),
    );
  }
  if (node.name === "TerminalSession") {
    const lines = attribute(node, "lines") as Array<{ cmd?: string; out?: string }> | undefined;
    if (!Array.isArray(lines)) throw new Error(`${where} needs lines`);
    const title = attribute(node, "title");
    return [
      {
        type: "code",
        lang: "bash",
        meta: typeof title === "string" ? `title="${title}"` : null,
        value: lines.map((line) => (line.cmd === undefined ? (line.out ?? "") : `$ ${line.cmd}`)).join("\n"),
      },
    ];
  }
  if (node.name && node.name in FIGURE_CAPTIONS) {
    const caption: { steps: readonly string[] } | { text: string } = FIGURE_CAPTIONS[node.name as FigureName];
    if ("text" in caption) return [paragraph(caption.text)];
    const list: List = {
      type: "list",
      ordered: true,
      spread: false,
      children: caption.steps.map((step) => ({ type: "listItem", spread: false, children: [paragraph(step)] })),
    };
    return [list];
  }
  throw new Error(`${where} has no Markdown form: add one to plugins/agent-docs.ts`);
}

/** `<dl>` as a list of "**Term**: definition" items. */
function definitions(node: MdxJsxFlowElement): List {
  const items: { term: PhrasingContent[]; definition: PhrasingContent[] }[] = [];
  // `<dt>` and `<dd>` on lines of their own are flow elements; on consecutive lines MDX reads them
  // as one paragraph of inline elements.
  const elements = (node.children as RootContent[]).flatMap((child) =>
    child.type === "paragraph" ? (child.children as RootContent[]) : [child],
  );
  for (const child of elements) {
    if (child.type !== "mdxJsxFlowElement" && child.type !== "mdxJsxTextElement") continue;
    const phrasing = (child.children as RootContent[]).flatMap((part) =>
      part.type === "paragraph" ? part.children : [part as PhrasingContent],
    );
    if (child.name === "dt") items.push({ term: phrasing, definition: [] });
    else if (child.name === "dd" && items.length > 0) items.at(-1)?.definition.push(...phrasing);
    else throw new Error(`<dl> holds a <${child.name}>: only <dt> and <dd> have a Markdown form`);
  }
  return {
    type: "list",
    ordered: false,
    spread: false,
    children: items.map(({ term, definition }) => ({
      type: "listItem",
      spread: false,
      children: [
        {
          type: "paragraph",
          children: [{ type: "strong", children: term }, { type: "text", value: ": " }, ...definition],
        },
      ],
    })),
  };
}

/** A caption's text, with `code` in backticks as code. */
function paragraph(text: string): Paragraph {
  const children = text
    .split("`")
    .map((part, index): PhrasingContent =>
      index % 2 ? { type: "inlineCode", value: part } : { type: "text", value: part },
    )
    .filter((part) => "value" in part && part.value !== "");
  return { type: "paragraph", children };
}

/** A JSX attribute's value: a string, or a literal expression (`lines={[{ cmd: "…" }]}`). */
function attribute(node: MdxJsxFlowElement, name: string): unknown {
  const attr = node.attributes.find(
    (candidate): candidate is MdxJsxAttribute => candidate.type === "mdxJsxAttribute" && candidate.name === name,
  );
  if (!attr || attr.value === null || attr.value === undefined) return undefined;
  if (typeof attr.value === "string") return attr.value;
  const program = attr.value.data?.estree;
  const statement = program?.body[0];
  if (statement?.type !== "ExpressionStatement") throw new Error(`${name}: not an expression`);
  return literal(statement.expression);
}

/** The value of a literal expression: arrays, objects, strings, numbers and booleans. Nothing is run. */
function literal(node: Expression): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) break;
      return node.quasis.map((quasi) => quasi.value.cooked).join("");
    case "ArrayExpression":
      return node.elements.map((element) => {
        if (!element || element.type === "SpreadElement") throw new Error("a spread or hole in an array literal");
        return literal(element);
      });
    case "ObjectExpression":
      return Object.fromEntries(
        node.properties.map((property) => {
          if (property.type !== "Property" || property.computed) throw new Error("a computed or spread property");
          const key = property.key.type === "Identifier" ? property.key.name : literal(property.key as Expression);
          return [String(key), literal(property.value as Expression)];
        }),
      );
  }
  throw new Error(`a ${node.type} isn't a literal`);
}

/** GitHub's alert markers (`> [!TIP]`) stay unescaped, so they read as callouts on GitHub too. */
function stringify(tree: Root): string {
  const markdown = unified()
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", fences: true, rule: "-", listItemIndent: "one" })
    .stringify(tree);
  return markdown.replace(/^> \\\[!(TIP|NOTE|WARNING)\]/gm, "> [!$1]");
}

/** The page cut at its H2 and H3 headings, each part linked by the id the site gives that heading. */
function chunksOf(tree: Root, entry: DocEntry): DocChunk[] {
  const idOf = headingIds();
  const chunks: DocChunk[] = [];
  let current: { id: string; heading: string; parts: string[]; prose: string[] } = {
    id: entry.path,
    heading: entry.title,
    parts: [],
    prose: [],
  };
  const close = () => {
    const text = current.parts.join("\n").trim();
    if (!text && current.id === entry.path) return;
    const prose = current.prose.join(" ").replace(/\s+/g, " ").trim() || text.replace(/\s+/g, " ");
    chunks.push({
      id: current.id,
      page: entry.title,
      heading: current.heading,
      section: entry.section,
      text,
      excerpt: prose.length > 280 ? `${prose.slice(0, 277).replace(/\s+\S*$/, "")}…` : prose,
    });
  };
  for (const node of tree.children) {
    if (node.type === "heading" && (node.depth === 2 || node.depth === 3)) {
      close();
      const heading = textOf(node);
      current = { id: `${entry.path}#${idOf(heading)}`, heading, parts: [], prose: [] };
      continue;
    }
    if (node.type === "heading" && node.depth === 1) continue;
    // A list's or quote's parts are separate sentences: joined with a space, not run together.
    const text =
      node.type === "list" || node.type === "blockquote"
        ? node.children.map((child) => textOf(child)).join(" ")
        : textOf(node as BlockContent);
    current.parts.push(text);
    if (node.type === "paragraph" || node.type === "list" || node.type === "blockquote") current.prose.push(text);
  }
  close();
  return chunks;
}

const SUMMARY =
  'channelstack is a test harness for apps and AI agents that live in Slack, GitHub, Linear and Notion. One server fakes those platforms in memory: tests act as people (`ana.say("@my-agent hi", { channel })`) and check what a person would see (`expect(thread).toHaveReplyFrom("my-agent")`). The same tests run against the real platforms in live mode. SDKs for TypeScript (Vitest), Python (pytest) and Rust.';

/** /llms.txt: the summary, then every page by section, linked to its Markdown. */
export function llmsTxt(pages: AgentPage[]): string {
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SUMMARY}`,
    "",
    `Every page below is Markdown; any docs page's URL plus \`.md\` gives its Markdown. All pages in one file: ${SITE.url}/llms-full.txt. To search the docs from an agent, add the MCP server at ${MCP_URL} (Streamable HTTP, no sign-in).`,
  ];
  let section = "";
  for (const { entry, markdownPath } of pages) {
    const title =
      entry.area === "reference" && entry.section !== "Reference" ? `Reference: ${entry.section}` : entry.section;
    if (title !== section) {
      section = title;
      lines.push("", `## ${title}`, "");
    }
    lines.push(`- [${entry.title}](${SITE.url}${markdownPath})${entry.description ? `: ${entry.description}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** /llms-full.txt: every page, in sidebar order, each with its URL under its title. */
export function llmsFullTxt(pages: AgentPage[]): string {
  const header = `# ${SITE.name} docs\n\n> ${SUMMARY}\n`;
  const body = pages.map(({ entry, markdown }) =>
    markdown.replace(/^# .*\n/, (title) => `${title}\nSource: ${SITE.url}${entry.path}\n`),
  );
  return [header, ...body].join("\n");
}

export function searchFile(pages: AgentPage[]): SearchFile {
  return {
    pages: pages.map(({ entry }) => ({
      path: entry.path,
      title: entry.title,
      section: entry.section,
      ...(entry.description ? { description: entry.description } : {}),
    })),
    index: buildIndex(pages.flatMap((page) => page.chunks)).toJSON(),
  };
}

/** Every file this plugin serves or writes, by its URL path. */
async function agentFiles(): Promise<Map<string, string>> {
  const pages = await loadAgentDocs();
  return new Map([
    ...pages.map((page): [string, string] => [page.markdownPath, page.markdown]),
    ["/llms.txt", llmsTxt(pages)],
    ["/llms-full.txt", llmsFullTxt(pages)],
    ["/docs-search.json", JSON.stringify(searchFile(pages))],
  ]);
}

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export default function agentDocs(): Plugin {
  let ssr = false;
  return {
    name: "channelstack:agent-docs",
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    // `vite dev` serves the same files, built on each request, so the page menu works there too.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // A `.md` page under website/docs is also a source module at the same URL: Vite's own
        // requests for it (`?import`, or as a script) go on to Vite.
        if ((req.url ?? "").includes("?") || req.headers["sec-fetch-dest"] === "script") return next();
        const path = decodeURIComponent(req.url ?? "");
        if (!/^\/(docs.*\.md|llms(-full)?\.txt|docs-search\.json)$/.test(path)) return next();
        try {
          const body = (await agentFiles()).get(path);
          if (body === undefined) return next();
          res.setHeader("Content-Type", TYPES[path.slice(path.lastIndexOf("."))] ?? "text/plain");
          res.end(body);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      if (ssr) return;
      for (const [path, source] of await agentFiles()) {
        this.emitFile({ type: "asset", fileName: relative("/", path), source });
      }
    },
  };
}
