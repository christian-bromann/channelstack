/**
 * `import sample from "../samples/slack.test.ts?sample"` gives the highlighted sample.
 *
 * Samples are real files. `pnpm typecheck:samples` checks the TypeScript ones against
 * ../api/*.d.ts; the Python ones are only syntax-checked (samples/python/README.md).
 * Two comment markers control what the site shows:
 *   // @show:start … // @show:end   show only this region (the whole file otherwise)
 *   // [!step 2]                    at the end of a line: tag it for the hero playback
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Plugin } from "vite";
import { highlightLines } from "./highlight";

const QUERY = "?sample";
const STEP = /\s*(?:\/\/|#)\s*\[!step (\d+)\]\s*$/;
const LANG: Record<string, string> = { ".ts": "ts", ".tsx": "tsx", ".py": "python", ".sh": "bash", ".json": "json" };

export interface Sample {
  /** The code as shown, without markers. This is what the copy button copies. */
  code: string;
  lang: string;
  /** Highlighted HTML, one entry per line. */
  lines: string[];
  /** Playback step per line (0 for none). */
  steps: number[];
}

export function parseSample(source: string): { code: string; steps: number[] } {
  let lines = source.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((l) => /@show:start/.test(l));
  const end = lines.findIndex((l) => /@show:end/.test(l));
  if (start !== -1 && end > start) lines = lines.slice(start + 1, end);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  const steps: number[] = [];
  lines = lines.map((line) => {
    const match = STEP.exec(line);
    steps.push(match ? Number(match[1]) : 0);
    return (match ? line.slice(0, match.index) : line).slice(indent);
  });
  return { code: lines.join("\n"), steps };
}

export default function samples(): Plugin {
  return {
    name: "channelstack:samples",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(QUERY)) return null;
      const file = id.slice(0, -QUERY.length);
      this.addWatchFile(file);
      const { code, steps } = parseSample(await readFile(file, "utf8"));
      const lang = LANG[extname(file)] ?? "text";
      const sample: Sample = { code, lang, lines: await highlightLines(code, lang), steps };
      return `export default ${JSON.stringify(sample)};`;
    },
  };
}
