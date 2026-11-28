import { OPENAI_IDS } from "../ids.ts";
import type { BuiltInTool } from "./shared.ts";

/** `computer`, run by the agent: a `computer_call` with its actions; the agent answers with a screenshot (`computer_call_output`). */
export const computer: BuiltInTool<"computer"> = {
  kind: "computer",
  types: ["computer", "computer_use_preview"],
  build(spec, { ids, tool }) {
    const id = ids.next(OPENAI_IDS.computer);
    const call = ids.next(OPENAI_IDS.call);
    // The preview tool takes one action a call; `computer` takes a list.
    const actions = tool.type === "computer_use_preview" ? { action: spec.actions[0] } : { actions: spec.actions };
    const item = {
      id,
      type: "computer_call",
      call_id: call,
      status: "completed",
      ...actions,
      pending_safety_checks: [],
    };
    return {
      type: "computer",
      hosted: false,
      name: "computer",
      arguments: { actions: spec.actions },
      id: call,
      items: [{ item, added: { ...item, status: "in_progress" }, events: () => [] }],
      ids: [id, call],
      text: JSON.stringify(spec.actions),
    };
  },
};
