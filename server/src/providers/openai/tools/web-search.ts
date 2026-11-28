import { OPENAI_IDS } from "../ids.ts";
import { TOOL_TYPES } from "./names.ts";
import { type BuiltInTool, statusEvents } from "./shared.ts";

/**
 * `web_search`, run by OpenAI: a `web_search_call` with its action and, when `include` asks for
 * them, its sources. What it found is what the script says; the citations go on the text.
 */
export const webSearch: BuiltInTool<"webSearch"> = {
  kind: "webSearch",
  types: TOOL_TYPES.webSearch,
  build(spec, { ids, request }) {
    const id = ids.next(OPENAI_IDS.webSearch);
    const sources = spec.sources ?? [];
    const withSources = request.includes.includes("web_search_call.action.sources");
    const action =
      spec.action === "search"
        ? {
            type: "search",
            query: spec.query,
            queries: [spec.query],
            ...(withSources ? { sources: sources.map((source) => ({ type: "url", url: source.url })) } : {}),
          }
        : spec.action === "open_page"
          ? { type: "open_page", url: spec.url ?? sources[0]?.url ?? null }
          : { type: "find_in_page", url: spec.url ?? sources[0]?.url ?? null, pattern: spec.pattern ?? spec.query };
    const item = { id, type: "web_search_call", status: "completed", action };
    return {
      type: "web_search",
      hosted: true,
      name: "web_search",
      arguments: { query: spec.query, action: spec.action },
      id,
      result: sources.map((source) => source.url).join("\n"),
      items: [
        {
          item,
          added: { id, type: "web_search_call", status: "in_progress", action },
          events: statusEvents("response.web_search_call", id, ["searching"]),
        },
      ],
      ids: [id],
      text: spec.query,
    };
  },
};
