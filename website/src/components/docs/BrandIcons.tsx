/**
 * The icons of the page menu (PageActions.tsx): the assistants' and editors' own marks, and line
 * icons for the rest. The marks come from Lobe Icons (`@lobehub/icons-static-svg`, MIT); the
 * trademarks are their owners'. Only their path data is used: the files' own `style` attributes
 * would break the Content-Security-Policy.
 */
import claude from "@lobehub/icons-static-svg/icons/claude.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex.svg?raw";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?raw";

interface PathData {
  d: string;
  clipRule?: "evenodd";
}

/** Every `<path>` of an SVG file, and nothing else from it. */
function pathsOf(svg: string): PathData[] {
  return [...svg.matchAll(/<path\b([^>]*)>/g)].map(([, attrs = ""]) => {
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) throw new Error("a brand icon's <path> has no d");
    return /clip-rule="evenodd"/.test(attrs) ? { d, clipRule: "evenodd" } : { d };
  });
}

const MARKS = {
  chatgpt: pathsOf(openai),
  claude: pathsOf(claude),
  codex: pathsOf(codex),
  cursor: pathsOf(cursor),
} as const;

export type Brand = keyof typeof MARKS;

/** 24×24 line icons, in the site's stroke style (components/Icons.tsx). */
const LINES = {
  markdown: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M7 15V9l2.5 3L12 9v6",
    "M17 9v6M15 13l2 2 2-2",
  ],
  editor: ["M4 4h16v16H4z", "M9 9l-2.5 3L9 15", "M15 9l2.5 3L15 15"],
  link: [
    "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1",
    "M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  ],
} as const;

export type LineIcon = keyof typeof LINES;

export function BrandIcon({ name, size = 18 }: { name: Brand | LineIcon; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, focusable: false } as const;
  if (name in LINES) {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {LINES[name as LineIcon].map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  return (
    <svg {...common} fill="currentColor" fillRule="evenodd">
      {MARKS[name as Brand].map(({ d, clipRule }) => (
        <path key={d} d={d} clipRule={clipRule} />
      ))}
    </svg>
  );
}
