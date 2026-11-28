import type { IdGenerator } from "../../../core/ids/index.ts";
import { OPENAI_IDS } from "../ids.ts";
import type { MediaStore } from "../media.ts";
import type { Turn } from "../turns.ts";
import type { Json } from "./shared.ts";

type Citation = NonNullable<Turn["citations"]>[number];

/**
 * A turn's citations as the annotations on its text, each marking the first occurrence of its
 * quote: `url_citation` for a page, `container_file_citation` for a file a code interpreter of
 * this answer wrote, `file_citation` for any other file. Chat Completions has only URL citations,
 * in its own shape. A quote the text doesn't have is a script problem.
 */
export function annotationsOf(
  text: string,
  citations: readonly Citation[],
  context: {
    readonly endpoint: "chat.completions" | "responses";
    readonly ids: IdGenerator;
    readonly media: MediaStore;
    /** The containers this answer's code interpreter calls used. */
    readonly containers: readonly string[];
    readonly script: string;
  },
): { annotations: Json[]; problems: string[] } {
  const annotations: Json[] = [];
  const problems: string[] = [];
  for (const citation of citations) {
    const start = text.indexOf(citation.quote);
    if (start === -1) {
      problems.push(`${context.script} cites ${JSON.stringify(citation.quote)}, which isn't in its text`);
      continue;
    }
    const end = start + citation.quote.length;
    if (citation.file === undefined) {
      const url = citation.url ?? "";
      if (url === "") {
        problems.push(`${context.script} cites ${JSON.stringify(citation.quote)} with neither a url nor a file`);
        continue;
      }
      const title = citation.title ?? url;
      annotations.push(
        context.endpoint === "chat.completions"
          ? { type: "url_citation", url_citation: { start_index: start, end_index: end, url, title } }
          : { type: "url_citation", start_index: start, end_index: end, url, title },
      );
      continue;
    }
    if (context.endpoint === "chat.completions") {
      problems.push(`${context.script} cites the file ${citation.file}, but Chat Completions has only URL citations`);
      continue;
    }
    const file = citation.file;
    const written = context.containers
      .flatMap((container) => [...(context.media.containers.get(container)?.values() ?? [])])
      .find((candidate) => candidate.filename === file || candidate.id === file || candidate.path === file);
    if (written) {
      annotations.push({
        type: "container_file_citation",
        container_id: written.container,
        file_id: written.id,
        start_index: start,
        end_index: end,
        filename: written.filename,
      });
      continue;
    }
    const stored = context.media.files.get(file) ?? [...context.media.files.values()].find((f) => f.filename === file);
    annotations.push({
      type: "file_citation",
      file_id: stored?.id ?? (file.startsWith("file-") ? file : context.ids.next(OPENAI_IDS.file)),
      index: end,
      filename: stored?.filename ?? citation.title ?? file,
    });
  }
  return { annotations, problems };
}
