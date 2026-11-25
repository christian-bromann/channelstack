/**
 * The icons of the page menu (PageActions.tsx): the assistants' and editors' own marks, and line
 * icons for the rest. The trademarks are their owners'; the site's footer credits the sources:
 *
 * - ChatGPT, Claude, Codex and Cursor: Lobe Icons (`@lobehub/icons-static-svg`, MIT).
 * - VS Code: Microsoft's own Codicons (`@vscode/codicons`, CC BY 4.0).
 *
 * Only their shapes are used (the viewBox and each path): the files' own `style` attributes would
 * break the Content-Security-Policy.
 */
import claude from "@lobehub/icons-static-svg/icons/claude.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex.svg?raw";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import vscode from "@vscode/codicons/src/icons/vscode.svg?raw";

interface Mark {
  viewBox: string;
  paths: { d: string; clipRule?: "evenodd" }[];
}

/** An SVG file's viewBox and every `<path>`, and nothing else from it. */
function markOf(svg: string): Mark {
  const viewBox = /\sviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) throw new Error("a brand icon has no viewBox");
  const paths = [...svg.matchAll(/<path\b([^>]*)>/g)].map(([, attrs = ""]) => {
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) throw new Error("a brand icon's <path> has no d");
    return /clip-rule="evenodd"/.test(attrs) ? { d, clipRule: "evenodd" as const } : { d };
  });
  return { viewBox, paths };
}

const MARKS = {
  chatgpt: markOf(openai),
  claude: markOf(claude),
  codex: markOf(codex),
  cursor: markOf(cursor),
  vscode: markOf(vscode),
} as const;

export type Brand = keyof typeof MARKS;

/** 24×24 line icons, in the site's stroke style (components/Icons.tsx). */
const LINES = {
  markdown: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M7 15V9l2.5 3L12 9v6",
    "M17 9v6M15 13l2 2 2-2",
  ],
  link: [
    "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1",
    "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  ],
} as const;

export type LineIcon = keyof typeof LINES;

export function BrandIcon({ name, size = 18 }: { name: Brand | LineIcon; size?: number }) {
  const common = { width: size, height: size, "aria-hidden": true, focusable: false } as const;
  if (name in LINES) {
    return (
      <svg
        {...common}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {LINES[name as LineIcon].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  const mark = MARKS[name as Brand];
  return (
    <svg {...common} viewBox={mark.viewBox} fill="currentColor" fillRule="evenodd">
      {mark.paths.map(({ d, clipRule }) => (
        <path key={d} d={d} clipRule={clipRule} />
      ))}
    </svg>
  );
}
