import { OPENAI_IDS } from "../ids.ts";
import { TOOL_TYPES } from "./names.ts";
import type { BuiltInCall, BuiltInTool } from "./shared.ts";

/**
 * `apply_patch`, run by the agent: an `apply_patch_call` per file operation, each with its own
 * `call_id`, which the agent answers with an `apply_patch_call_output`.
 */
export const applyPatch: BuiltInTool<"applyPatch"> = {
  kind: "applyPatch",
  types: TOOL_TYPES.applyPatch,
  problems(spec) {
    const missing = spec.operations.find(
      (operation) => operation.type !== "delete_file" && operation.diff === undefined,
    );
    return missing === undefined ? [] : [`called \`apply_patch\` to ${missing.type} ${missing.path} without a diff`];
  },
  build(spec, { ids }): BuiltInCall[] {
    return spec.operations.map((operation) => {
      const id = ids.next(OPENAI_IDS.applyPatch);
      const call = ids.next(OPENAI_IDS.call);
      const wire =
        operation.type === "delete_file"
          ? { type: "delete_file", path: operation.path }
          : { type: operation.type, path: operation.path, diff: operation.diff ?? "" };
      const item = { id, type: "apply_patch_call", call_id: call, status: "completed", operation: wire };
      return {
        type: "apply_patch",
        hosted: false,
        name: "apply_patch",
        arguments: wire,
        id: call,
        items: [{ item, added: { ...item, status: "in_progress" }, events: () => [] }],
        ids: [id, call],
        text: JSON.stringify(wire),
      };
    });
  },
};
