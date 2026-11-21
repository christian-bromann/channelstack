/** Highlights fenced code blocks in the docs with the same tokens as the home page samples. */
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";

import { resolveLang, tokenize } from "./highlight";

const textOf = (node: ElementContent): string =>
  node.type === "text" ? node.value : node.type === "element" ? node.children.map(textOf).join("") : "";

export default function rehypeHighlight() {
  return async (tree: Root) => {
    const blocks: Array<{ code: Element; lang: string }> = [];
    visit(tree, "element", (node, _index, parent) => {
      if (node.tagName !== "code" || parent?.type !== "element" || parent.tagName !== "pre") return;
      const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
      const lang = classes
        .map(String)
        .find((c) => c.startsWith("language-"))
        ?.slice("language-".length);
      if (resolveLang(lang)) blocks.push({ code: node, lang: lang! });
    });
    for (const { code, lang } of blocks) {
      const lines = await tokenize(textOf(code).replace(/\n$/, ""), lang);
      code.children = lines.flatMap((line, i): ElementContent[] => [
        ...line.map((t): ElementContent =>
          t.kind
            ? {
                type: "element",
                tagName: "span",
                properties: { className: [`t-${t.kind}`] },
                children: [{ type: "text", value: t.text }],
              }
            : { type: "text", value: t.text },
        ),
        ...(i < lines.length - 1 ? [{ type: "text", value: "\n" } as ElementContent] : []),
      ]);
    }
  };
}
