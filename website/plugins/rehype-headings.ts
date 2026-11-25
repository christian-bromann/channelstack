/**
 * Gives every H2 and H3 an id from its text and a `#` link to itself, so sections can be linked
 * and the page outline can find them. Ids repeat-proof: a second "Options" becomes `options-1`.
 */
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";

const textOf = (node: ElementContent): string =>
  node.type === "text" ? node.value : node.type === "element" ? node.children.map(textOf).join("") : "";

/** "Waiting and `quiet`!" → "waiting-and-quiet". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function rehypeHeadings() {
  return (tree: Root) => {
    const seen = new Map<string, number>();
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const base = slugify(node.children.map(textOf).join("")) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;
      node.properties.id = id;
      node.children.push({
        type: "element",
        tagName: "a",
        properties: { className: ["anchor"], href: `#${id}`, ariaLabel: "Link to this section" },
        children: [{ type: "text", value: "#" }],
      });
    });
  };
}
