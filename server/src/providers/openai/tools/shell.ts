import { OPENAI_IDS } from "../ids.ts";
import type { ModelTool } from "../request.ts";
import { TOOL_TYPES } from "./names.ts";
import type { BuiltInTool, ToolEvent, ToolItem } from "./shared.ts";

/** A `shell` tool runs in OpenAI's container when its environment is one; otherwise, and `local_shell` always, the agent runs it. */
const hostedShell = (tool: ModelTool): boolean => {
  const environment = tool.settings?.environment as { type?: unknown } | null | undefined;
  return (
    tool.type === "shell" && (environment?.type === "container_auto" || environment?.type === "container_reference")
  );
};

/**
 * `shell`: hosted, a `shell_call` and its `shell_call_output` with what the script says it
 * printed; local, a `shell_call` (or `local_shell_call`) the agent runs and answers with
 * `shell_call_output`.
 */
export const shell: BuiltInTool<"shell"> = {
  kind: "shell",
  types: TOOL_TYPES.shell,
  problems(spec, { tool }) {
    if (!hostedShell(tool) && spec.output !== undefined)
      return ["gave a shell's output, but the request's shell runs on the agent's side: the agent sends the output"];
    return [];
  },
  build(spec, { ids, tool }) {
    const call = ids.next(OPENAI_IDS.call);
    const hosted = hostedShell(tool);
    const action = { commands: spec.commands, timeout_ms: null, max_output_length: null };
    if (tool.type === "local_shell") {
      const id = ids.next(OPENAI_IDS.localShell);
      const item = {
        id,
        type: "local_shell_call",
        call_id: call,
        status: "completed",
        action: { type: "exec", command: ["bash", "-lc", spec.commands.join(" && ")], env: {} },
      };
      return {
        type: "shell",
        hosted: false,
        name: "local_shell",
        arguments: { commands: spec.commands },
        id: call,
        items: [{ item, added: { ...item, status: "in_progress" }, events: () => [] }],
        ids: [id, call],
        text: spec.commands.join("\n"),
      };
    }
    const id = ids.next(OPENAI_IDS.shellCall);
    const settings = (tool.settings?.environment ?? {}) as { type?: string; container_id?: string };
    const container = settings.type === "container_reference" ? (settings.container_id ?? "") : undefined;
    const environment = hosted
      ? { type: "container_reference", container_id: container ?? ids.next(OPENAI_IDS.container) }
      : { type: "local" };
    const item = { id, type: "shell_call", call_id: call, status: "completed", action, environment };
    const commandEvents = (output_index: number): ToolEvent[] =>
      spec.commands.flatMap((command, command_index) => [
        { type: "response.shell_call_command.added", data: { output_index, command_index, command: "" } },
        {
          type: "response.shell_call_command.delta",
          data: { output_index, command_index, delta: command },
          content: true,
        },
        { type: "response.shell_call_command.done", data: { output_index, command_index, command } },
      ]);
    const items: ToolItem[] = [
      { item, added: { ...item, status: "in_progress", action: { ...action, commands: [] } }, events: commandEvents },
    ];
    const minted = [id, call];
    if (hosted) {
      const outputId = ids.next(OPENAI_IDS.shellOutput);
      minted.push(outputId);
      const content = [{ stdout: spec.output ?? "", stderr: "", outcome: { type: "exit", exit_code: 0 } }];
      const output = {
        id: outputId,
        type: "shell_call_output",
        call_id: call,
        status: "completed",
        output: content,
        max_output_length: null,
      };
      items.push({
        item: output,
        added: { ...output, status: "in_progress", output: [] },
        events: (output_index) => [
          {
            type: "response.shell_call_output_content.delta",
            data: { item_id: outputId, output_index, command_index: 0, delta: { stdout: spec.output ?? "" } },
            content: true,
          },
          {
            type: "response.shell_call_output_content.done",
            data: { item_id: outputId, output_index, command_index: 0, output: content },
          },
        ],
      });
    }
    return {
      type: "shell",
      hosted,
      name: "shell",
      arguments: { commands: spec.commands },
      id: call,
      ...(hosted ? { result: spec.output ?? "" } : {}),
      items,
      ids: minted,
      text: spec.commands.join("\n") + (spec.output ?? ""),
    };
  },
};
