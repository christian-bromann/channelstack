/**
 * Build-time syntax highlighting. Tokens become class names (`t-keyword`, …) instead of
 * inline styles, so the pages need no inline CSS and ship no highlighter to the browser.
 */
import { createCssVariablesTheme, createHighlighter, type Highlighter } from "shiki";

const PREFIX = "--t-";
const theme = createCssVariablesTheme({ name: "channelstack", variablePrefix: PREFIX, fontStyle: false });
const LANGS = ["ts", "tsx", "js", "python", "bash", "json", "jsonc", "yaml", "diff"] as const;
const ALIASES: Record<string, string> = { typescript: "ts", javascript: "js", py: "python", sh: "bash", shell: "bash", yml: "yaml" };

export interface Token {
  /** Class name without the `t-` prefix, or undefined for plain text. */
  kind?: string;
  text: string;
}

let highlighter: Promise<Highlighter> | undefined;

export function resolveLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const name = ALIASES[lang] ?? lang;
  return (LANGS as readonly string[]).includes(name) ? name : undefined;
}

/** Splits code into lines of tokens. Unknown languages come back as plain text. */
export async function tokenize(code: string, lang: string | undefined): Promise<Token[][]> {
  const name = resolveLang(lang);
  if (!name) return code.split("\n").map((text) => [{ text }]);
  highlighter ??= createHighlighter({ themes: [theme], langs: [...LANGS] });
  const { tokens } = (await highlighter).codeToTokens(code, { lang: name as (typeof LANGS)[number], theme: "channelstack" });
  return tokens.map((line) =>
    line.map((token) => {
      const match = /--t-token-([a-z-]+)/.exec(token.color ?? "");
      return { kind: match?.[1], text: token.content };
    }),
  );
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One HTML string per line of code. */
export async function highlightLines(code: string, lang: string | undefined): Promise<string[]> {
  const lines = await tokenize(code, lang);
  return lines.map((line) =>
    line.map((t) => (t.kind ? `<span class="t-${t.kind}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text))).join(""),
  );
}
