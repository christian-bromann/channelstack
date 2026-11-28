import { OPENAI_IDS } from "../ids.ts";
import { TOOL_TYPES } from "./names.ts";
import { type BuiltInTool, statusEvents } from "./shared.ts";

/**
 * `file_search`, run by OpenAI over the request's vector stores: a `file_search_call` with its
 * queries and, when `include` asks for them, its results. A result names a file by its id
 * (`file-…`, one uploaded to `/v1/files`) or by its name.
 */
export const fileSearch: BuiltInTool<"fileSearch"> = {
  kind: "fileSearch",
  types: TOOL_TYPES.fileSearch,
  build(spec, { ids, request, media }) {
    const id = ids.next(OPENAI_IDS.fileSearch);
    const results = (spec.results ?? []).map((result) => {
      const stored =
        media.files.get(result.file) ?? [...media.files.values()].find((file) => file.filename === result.file);
      return {
        file_id: stored?.id ?? (result.file.startsWith("file-") ? result.file : ids.next(OPENAI_IDS.file)),
        filename: stored?.filename ?? result.file,
        text: result.text,
        score: result.score ?? 0.9,
        attributes: {},
      };
    });
    const withResults = request.includes.includes("file_search_call.results");
    const item = {
      id,
      type: "file_search_call",
      status: "completed",
      queries: spec.queries,
      results: withResults ? results : null,
    };
    return {
      type: "file_search",
      hosted: true,
      name: "file_search",
      arguments: { queries: spec.queries },
      id,
      result: results.map((result) => result.text).join("\n"),
      items: [
        {
          item,
          added: { id, type: "file_search_call", status: "in_progress", queries: [], results: null },
          events: statusEvents("response.file_search_call", id, ["searching"]),
        },
      ],
      ids: [id],
      text: spec.queries.join(" "),
    };
  },
};
