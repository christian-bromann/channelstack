import type { BuiltInKind } from "../turns.ts";

/** The request's tool types each built-in tool is offered by, in the order they are looked for. */
export const TOOL_TYPES: { readonly [K in BuiltInKind]: readonly string[] } = {
  webSearch: ["web_search", "web_search_preview"],
  fileSearch: ["file_search"],
  codeInterpreter: ["code_interpreter"],
  imageGeneration: ["image_generation"],
  mcp: ["mcp"],
  shell: ["shell", "local_shell"],
  computer: ["computer", "computer_use_preview"],
  applyPatch: ["apply_patch"],
};

/** Every tool type the Responses API offers as a built-in tool: what a request may name besides functions and custom tools. */
export const BUILT_IN_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(TOOL_TYPES).flat(),
  "web_search_2025_08_26",
  "web_search_preview_2025_03_11",
]);

/** A built-in tool type, without its date: `web_search_2025_08_26` is `web_search`. */
export const undated = (type: string): string => type.replace(/_\d{4}_\d{2}_\d{2}$/, "");
