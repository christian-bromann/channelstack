/**
 * GitHub's alert syntax as callouts: a blockquote that starts with `[!TIP]`, `[!NOTE]` or
 * `[!WARNING]` becomes `<aside class="callout tip">` with a title, so the pages read the same on
 * GitHub and on the site.
 */
import type { Blockquote, Paragraph, Root } from "mdast";
import { visit } from "unist-util-visit";

const KINDS = { TIP: "Tip", NOTE: "Note", WARNING: "Warning" } as const;
const MARKER = /^\[!(TIP|NOTE|WARNING)\][ \t]*(?:\r?\n|$)/;

export default function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== "paragraph") return;
      const text = first.children[0];
      if (text?.type !== "text") return;
      const match = MARKER.exec(text.value);
      if (!match) return;
      const kind = match[1] as keyof typeof KINDS;
      text.value = text.value.slice(match[0].length);
      if (text.value === "") first.children.shift();
      if (first.children.length === 0) node.children.shift();
      const title: Paragraph = {
        type: "paragraph",
        data: { hProperties: { className: ["callout-title"] } },
        children: [{ type: "text", value: KINDS[kind] }],
      };
      node.children.unshift(title);
      node.data = { hName: "aside", hProperties: { className: ["callout", kind.toLowerCase()] } };
    });
  };
}
