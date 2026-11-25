/**
 * GitHub's alert syntax as callouts: a blockquote that starts with `[!TIP]`, `[!NOTE]` or
 * `[!WARNING]` becomes `<aside class="callout tip">`, so the pages read the same on GitHub and on
 * the site. The callout gets a line icon, and its label runs into the first sentence ("Tip"), the
 * way an editor would set it, rather than sitting on a line of its own.
 */
import type { ElementContent } from "hast";
import type { Blockquote, Paragraph, PhrasingContent, Root, Strong } from "mdast";
import { visit } from "unist-util-visit";

const KINDS = { TIP: "Tip", NOTE: "Note", WARNING: "Warning" } as const;
type Kind = keyof typeof KINDS;
const MARKER = /^\[!(TIP|NOTE|WARNING)\][ \t]*(?:\r?\n|$)/;

/** 24×24 line icons, drawn with the text color: a light bulb, an "i" in a circle, a warning triangle. */
const ICONS: Record<Kind, ElementContent[]> = {
  TIP: [
    path("M9 18h6"),
    path("M10 21h4"),
    path("M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.2.9 1.9V16h5.4v-.3c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3z"),
  ],
  NOTE: [circle(12, 12, 9), path("M12 11v5"), path("M12 7.5h.01")],
  WARNING: [
    path("M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"),
    path("M12 9.5v4"),
    path("M12 17h.01"),
  ],
};

function path(d: string): ElementContent {
  return { type: "element", tagName: "path", properties: { d }, children: [] };
}

function circle(cx: number, cy: number, r: number): ElementContent {
  return { type: "element", tagName: "circle", properties: { cx: String(cx), cy: String(cy), r: String(r) }, children: [] };
}

export default function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== "paragraph") return;
      const text = first.children[0];
      if (text?.type !== "text") return;
      const match = MARKER.exec(text.value);
      if (!match) return;
      const kind = match[1] as Kind;
      text.value = text.value.slice(match[0].length);
      if (text.value === "") first.children.shift();
      if (first.children.length === 0) node.children.shift();

      const label: Strong = {
        type: "strong",
        data: { hProperties: { className: ["callout-label"] } },
        children: [{ type: "text", value: KINDS[kind] }],
      };
      // The label runs into the first paragraph; before anything else (a list), it stands alone.
      const opening = node.children[0];
      if (opening?.type === "paragraph") {
        opening.children.unshift(label, { type: "text", value: " " } as PhrasingContent);
      } else {
        const alone: Paragraph = { type: "paragraph", children: [label] };
        node.children.unshift(alone);
      }

      const icon = {
        type: "paragraph",
        data: {
          hName: "svg",
          hProperties: {
            className: ["callout-icon"],
            viewBox: "0 0 24 24",
            ariaHidden: "true",
            focusable: "false",
          },
          hChildren: ICONS[kind],
        },
        children: [],
      } as Paragraph;
      node.children.unshift(icon);
      node.data = { hName: "aside", hProperties: { className: ["callout", kind.toLowerCase()] } };
    });
  };
}
