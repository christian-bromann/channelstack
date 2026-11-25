/**
 * The three files of one docs example (`<Example id="slack-mention-one-reply" />`), relative to
 * website/examples/. The page shows them as tabs (components/docs/Example.tsx); the page's
 * Markdown shows them as code blocks (plugins/agent-docs.ts).
 */
export const EXAMPLE_LANGUAGES = [
  { title: "TypeScript", lang: "ts", file: (id: string) => `ts/${id}.test.ts` },
  { title: "Python", lang: "python", file: (id: string) => `python/test_${id.replaceAll("-", "_")}.py` },
  { title: "Rust", lang: "rust", file: (id: string) => `rust/src/${id.replaceAll("-", "_")}.rs` },
] as const;
