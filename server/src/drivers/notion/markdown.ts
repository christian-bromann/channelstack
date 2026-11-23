/**
 * Markdown in and out of Notion blocks: what a test writes as page content becomes the blocks
 * Notion would make of it, and a page's blocks read back as Markdown. Parsing is `marked`'s
 * lexer; nothing is rendered.
 */
import { lexer, type Token, type Tokens } from "marked";

import { type Annotations, plainText, type RichTextItem, textItem } from "./rich-text.ts";

/** A block before it has an id: its type, the type's object, and its children. */
export interface BlockDraft {
  type: string;
  data: Record<string, unknown>;
  children: BlockDraft[];
}

const text = (rich: RichTextItem[], extra: Record<string, unknown> = {}) => ({
  rich_text: rich,
  color: "default",
  ...extra,
});

/** Inline Markdown → rich text runs with their marks. */
function inline(
  tokens: readonly Token[] | undefined,
  marks: Partial<Annotations> = {},
  link: string | null = null,
): RichTextItem[] {
  const runs: RichTextItem[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        runs.push(...inline((token as Tokens.Strong).tokens, { ...marks, bold: true }, link));
        break;
      case "em":
        runs.push(...inline((token as Tokens.Em).tokens, { ...marks, italic: true }, link));
        break;
      case "del":
        runs.push(...inline((token as Tokens.Del).tokens, { ...marks, strikethrough: true }, link));
        break;
      case "codespan":
        runs.push(textItem((token as Tokens.Codespan).text, { ...marks, code: true }, link));
        break;
      case "link":
        runs.push(...inline((token as Tokens.Link).tokens, marks, (token as Tokens.Link).href));
        break;
      case "br":
        runs.push(textItem("\n", marks, link));
        break;
      case "text":
      case "escape":
        if ("tokens" in token && token.tokens) runs.push(...inline(token.tokens, marks, link));
        else runs.push(textItem((token as Tokens.Text).text, marks, link));
        break;
      default:
        runs.push(textItem(token.raw, marks, link));
    }
  }
  // Neighbouring runs with the same marks are one run, as Notion stores them.
  return runs.reduce<RichTextItem[]>((merged, run) => {
    const last = merged.at(-1);
    if (
      last?.type === "text" &&
      run.type === "text" &&
      last.href === run.href &&
      JSON.stringify(last.annotations) === JSON.stringify(run.annotations)
    ) {
      merged[merged.length - 1] = textItem(last.plain_text + run.plain_text, last.annotations, last.href);
    } else merged.push(run);
    return merged;
  }, []);
}

function listItems(list: Tokens.List): BlockDraft[] {
  return list.items.map((item) => {
    // A task item starts with its checkbox; the text is what follows.
    const [first, ...rest] = item.tokens.filter((token) => token.type !== "checkbox");
    const rich = first && "tokens" in first ? inline(first.tokens) : [];
    const children = blocksOf(rest);
    if (item.task) return { type: "to_do", data: text(rich, { checked: item.checked === true }), children };
    return { type: list.ordered ? "numbered_list_item" : "bulleted_list_item", data: text(rich), children };
  });
}

function blocksOf(tokens: readonly Token[]): BlockDraft[] {
  const blocks: BlockDraft[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const { depth, tokens: runs } = token as Tokens.Heading;
        blocks.push({
          type: `heading_${Math.min(depth, 3)}`,
          data: text(inline(runs), { is_toggleable: false }),
          children: [],
        });
        break;
      }
      case "paragraph":
        blocks.push({ type: "paragraph", data: text(inline((token as Tokens.Paragraph).tokens)), children: [] });
        break;
      case "text":
        blocks.push({ type: "paragraph", data: text(inline((token as Tokens.Text).tokens ?? [token])), children: [] });
        break;
      case "list":
        blocks.push(...listItems(token as Tokens.List));
        break;
      case "code": {
        const { text: code, lang } = token as Tokens.Code;
        blocks.push({
          type: "code",
          data: { rich_text: [textItem(code)], language: lang || "plain text", caption: [] },
          children: [],
        });
        break;
      }
      case "blockquote":
        blocks.push({
          type: "quote",
          data: text(
            inline(
              (token as Tokens.Blockquote).tokens.flatMap((inner) =>
                "tokens" in inner ? (inner.tokens ?? []) : [inner],
              ),
            ),
          ),
          children: [],
        });
        break;
      case "hr":
        blocks.push({ type: "divider", data: {}, children: [] });
        break;
      case "space":
        break;
      default:
        blocks.push({ type: "paragraph", data: text([textItem(token.raw.trim())]), children: [] });
    }
  }
  return blocks;
}

/** Markdown → the blocks Notion makes of it. */
export function markdownToBlocks(markdown: string): BlockDraft[] {
  return blocksOf(lexer(markdown));
}

/** Rich text → inline Markdown: marks and links, and a mention as `@Name`. */
function richToMarkdown(rich: readonly RichTextItem[]): string {
  return rich
    .map((item) => {
      if (item.type !== "text") return item.plain_text;
      let out = item.plain_text;
      const { bold, italic, strikethrough, code } = item.annotations;
      if (code) out = `\`${out}\``;
      if (bold) out = `**${out}**`;
      if (italic) out = `_${out}_`;
      if (strikethrough) out = `~~${out}~~`;
      return item.href ? `[${out}](${item.href})` : out;
    })
    .join("");
}

/** A block as one or more lines of Markdown; `children` are its own blocks, already in Markdown. */
export function blockToMarkdown(type: string, data: Record<string, unknown>, children: string[]): string {
  const rich = (data.rich_text as RichTextItem[] | undefined) ?? [];
  const line = richToMarkdown(rich);
  const nested = children.map((child) => child.replace(/^/gm, "  "));
  const withChildren = (first: string) => [first, ...nested].join("\n");
  switch (type) {
    case "heading_1":
      return `# ${line}`;
    case "heading_2":
      return `## ${line}`;
    case "heading_3":
      return `### ${line}`;
    case "bulleted_list_item":
      return withChildren(`- ${line}`);
    case "numbered_list_item":
      return withChildren(`1. ${line}`);
    case "to_do":
      return withChildren(`- [${data.checked === true ? "x" : " "}] ${line}`);
    case "quote":
      return `> ${line}`;
    case "code":
      return `\`\`\`${data.language === "plain text" ? "" : String(data.language ?? "")}\n${plainText(rich)}\n\`\`\``;
    case "divider":
      return "---";
    case "child_page":
      return `[${String(data.title ?? "")}]`;
    case "child_database":
      return `[${String(data.title ?? "")}]`;
    default:
      return withChildren(line);
  }
}
