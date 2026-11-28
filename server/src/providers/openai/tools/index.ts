import { BUILT_IN_KINDS, type BuiltInKind, type ToolCallInput } from "../turns.ts";
import { applyPatch } from "./apply-patch.ts";
import { codeInterpreter } from "./code-interpreter.ts";
import { computer } from "./computer.ts";
import { fileSearch } from "./file-search.ts";
import { imageGeneration } from "./image-generation.ts";
import { mcp } from "./mcp.ts";
import { undated } from "./names.ts";
import type { BuiltInCall, BuiltInTool, ToolContext } from "./shared.ts";
import { shell } from "./shell.ts";
import { webSearch } from "./web-search.ts";

export type { BuiltInCall } from "./shared.ts";

const TOOLS: { readonly [K in BuiltInKind]: BuiltInTool<K> } = {
  webSearch,
  fileSearch,
  codeInterpreter,
  imageGeneration,
  mcp,
  shell,
  computer,
  applyPatch,
};

/** The built-in kind of a scripted tool call, if it is one. */
export const builtInKindOf = (spec: ToolCallInput): BuiltInKind | undefined =>
  BUILT_IN_KINDS.find((kind) => spec[kind] !== undefined);

/** How a script names a built-in kind in a problem: `webSearch` is `web_search`. */
const typeName = (kind: BuiltInKind) => TOOLS[kind].types[0] ?? kind;

/**
 * A turn's built-in tool calls, built for this request: each one's items, or the reasons the
 * real API couldn't make it (a tool the request didn't offer, a server it doesn't name, a
 * placeholder in a format the fake can't make).
 */
export function buildBuiltIns(
  specs: readonly ToolCallInput[],
  context: Omit<ToolContext, "tool">,
  script: string,
): { calls: BuiltInCall[]; problems: string[] } {
  const calls: BuiltInCall[] = [];
  const problems: string[] = [];
  const { request } = context;
  for (const spec of specs) {
    const kind = builtInKindOf(spec);
    if (kind === undefined) continue;
    const tool = TOOLS[kind] as BuiltInTool<typeof kind>;
    const value = spec[kind] as never;
    if (request.endpoint !== "responses") {
      problems.push(`${script} called the built-in tool \`${typeName(kind)}\`, which only the Responses API has`);
      continue;
    }
    const offered = request.tools.filter((candidate) => tool.types.includes(undated(candidate.type)));
    const chosen = tool.pick ? tool.pick(value, offered) : offered[0];
    if (!chosen) {
      const names = request.tools.map((candidate) => `\`${candidate.name ?? candidate.type}\``);
      const what =
        kind === "mcp" ? `the MCP server \`${(value as { server: string }).server}\`` : `\`${typeName(kind)}\``;
      problems.push(
        `${script} called ${what}, but the request offered ${names.length === 0 ? "no tools" : names.join(", ")}`,
      );
      continue;
    }
    if (request.toolChoice === "none") {
      problems.push(`${script} called \`${typeName(kind)}\`, but the request's tool_choice is "none"`);
      continue;
    }
    const full = { ...context, tool: chosen };
    const own = tool.problems?.(value, full) ?? [];
    if (own.length > 0) {
      problems.push(...own.map((problem) => `${script} ${problem}`));
      continue;
    }
    const built = tool.build(value, full);
    if ("problem" in built) problems.push(`${script} ${built.problem}`);
    else calls.push(...(Array.isArray(built) ? built : [built as BuiltInCall]));
  }
  return { calls, problems };
}
