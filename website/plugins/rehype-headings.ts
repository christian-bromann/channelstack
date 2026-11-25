/**
 * Gives every H2 and H3 an id from its text and a `#` link to itself, so sections can be linked
 * and the page outline can find them. The ids come from ./slug.ts, which the API reference's
 * generator links with too.
 */
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";
import { headingIds } from "./slug";

const textOf = (node: ElementContent): string =>
  node.type === "text" ? node.value : node.type === "element" ? node.children.map(textOf).join("") : "";

export default function rehypeHeadings() {
  return (tree: Root) => {
    const idOf = headingIds();
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const id = idOf(node.children.map(textOf).join(""));
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
