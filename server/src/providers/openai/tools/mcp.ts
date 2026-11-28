import { jsonChunks } from "../codecs/answer.ts";
import { OPENAI_IDS } from "../ids.ts";
import type { ModelTool } from "../request.ts";
import { type BuiltInTool, type Json, statusEvents, type ToolEvent, type ToolItem } from "./shared.ts";

/** The names a filter lists: a list of names, or `{ tool_names }`. */
const namesOf = (filter: unknown): string[] | undefined => {
  if (Array.isArray(filter)) return filter.filter((name): name is string => typeof name === "string");
  if (typeof filter === "object" && filter !== null && Array.isArray((filter as Json).tool_names))
    return ((filter as Json).tool_names as unknown[]).filter((name): name is string => typeof name === "string");
  return undefined;
};

/** Whether the request's `require_approval` asks for approval before this tool runs. Its default is `always`. */
function needsApproval(tool: ModelTool, name: string): boolean {
  const setting = tool.settings?.require_approval;
  if (setting === undefined || setting === null || setting === "always") return true;
  if (setting === "never") return false;
  const filters = setting as Json;
  if (namesOf(filters.never)?.includes(name)) return false;
  if (namesOf(filters.always)?.includes(name)) return true;
  return true;
}

/**
 * A remote MCP server's tool, called by OpenAI: `mcp_list_tools` the first time the server is
 * used in a conversation, then `mcp_call`, or an `mcp_approval_request` the agent answers with an
 * `mcp_approval_response`. The fake calls no server: the output is the script's.
 */
export const mcp: BuiltInTool<"mcp"> = {
  kind: "mcp",
  types: ["mcp"],
  pick: (spec, offered) => offered.find((tool) => tool.settings?.server_label === spec.server),
  problems(spec, { tool, request }) {
    const allowed = namesOf(tool.settings?.allowed_tools);
    if (allowed !== undefined && !allowed.includes(spec.tool)) {
      return [
        `called \`${spec.tool}\` on the MCP server \`${spec.server}\`, but the request allows only ${allowed.map((name) => `\`${name}\``).join(", ") || "no tools"}`,
      ];
    }
    const required = needsApproval(tool, spec.tool);
    const answered = request.approvals.find(
      (approval) => approval.server === spec.server && approval.tool === spec.tool,
    );
    if (spec.approval === true) {
      return required
        ? []
        : [`asked to approve \`${spec.tool}\`, but the request's require_approval says it runs without approval`];
    }
    if (answered?.approve === false)
      return [`called \`${spec.tool}\` on \`${spec.server}\`, but the agent declined its approval request`];
    if (required && answered === undefined) {
      return [
        `called \`${spec.tool}\` on \`${spec.server}\` without approval, but the request's require_approval asks for it: script \`approval: true\` first`,
      ];
    }
    return [];
  },
  build(spec, { ids, request, tool }) {
    const args = JSON.stringify(spec.arguments ?? {});
    const items: ToolItem[] = [];
    const minted: string[] = [];
    if (!request.listedMcp.includes(spec.server)) {
      const id = ids.next(OPENAI_IDS.mcpList);
      minted.push(id);
      const allowed = namesOf(tool.settings?.allowed_tools) ?? [spec.tool];
      const item = {
        id,
        type: "mcp_list_tools",
        server_label: spec.server,
        tools: allowed.map((name) => ({ name, input_schema: { type: "object", properties: {} }, annotations: null })),
        error: null,
      };
      items.push({
        item,
        added: { ...item, tools: [] },
        events: statusEvents("response.mcp_list_tools", id),
      });
    }
    if (spec.approval === true) {
      const id = ids.next(OPENAI_IDS.mcpApproval);
      minted.push(id);
      const item = { id, type: "mcp_approval_request", server_label: spec.server, name: spec.tool, arguments: args };
      items.push({ item, added: item, events: () => [] });
      return {
        type: "mcp",
        hosted: true,
        name: spec.tool,
        arguments: spec.arguments ?? {},
        id,
        items,
        ids: minted,
        text: spec.tool + args,
      };
    }
    const id = ids.next(OPENAI_IDS.mcpCall);
    minted.push(id);
    const approval = request.approvals.find((answer) => answer.server === spec.server && answer.tool === spec.tool);
    const failed = spec.error !== undefined;
    const item = {
      id,
      type: "mcp_call",
      status: failed ? "failed" : "completed",
      server_label: spec.server,
      name: spec.tool,
      arguments: args,
      output: spec.output ?? null,
      error: failed ? { type: "mcp_tool_execution_error", content: [{ type: "text", text: spec.error }] } : null,
      approval_request_id: approval?.requestId ?? null,
    };
    const events = (output_index: number): ToolEvent[] => [
      { type: "response.mcp_call.in_progress", data: { output_index, item_id: id } },
      ...jsonChunks(args).map((delta) => ({
        type: "response.mcp_call_arguments.delta",
        data: { output_index, item_id: id, delta },
        content: true,
      })),
      { type: "response.mcp_call_arguments.done", data: { output_index, item_id: id, arguments: args } },
      {
        type: failed ? "response.mcp_call.failed" : "response.mcp_call.completed",
        data: { output_index, item_id: id },
      },
    ];
    items.push({
      item,
      added: { ...item, status: "in_progress", arguments: "", output: null, error: null },
      events,
    });
    return {
      type: "mcp",
      hosted: true,
      name: spec.tool,
      arguments: spec.arguments ?? {},
      id,
      result: spec.output ?? spec.error ?? "",
      items,
      ids: minted,
      text: spec.tool + args + (spec.output ?? ""),
    };
  },
};
