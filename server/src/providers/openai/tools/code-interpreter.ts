import { OPENAI_IDS } from "../ids.ts";
import { anyMedia, base64Of } from "../media.ts";
import { type BuiltInTool, type ToolEvent } from "./shared.ts";

/**
 * `code_interpreter`, run by OpenAI in a container: a `code_interpreter_call` with its code and,
 * when `include` asks for them, its outputs (logs, and an image per image file). The files the
 * code wrote are the container's, downloadable from `/v1/containers/{container}/files/{file}/content`.
 */
export const codeInterpreter: BuiltInTool<"codeInterpreter"> = {
  kind: "codeInterpreter",
  types: ["code_interpreter"],
  build(spec, { ids, clock, request, tool, media }) {
    const id = ids.next(OPENAI_IDS.codeInterpreter);
    // `container` is a container's id, or `{ type: "auto" }`: a new one.
    const given = tool.settings?.container;
    const container = typeof given === "string" ? given : ids.next(OPENAI_IDS.container);
    const files = (spec.files ?? []).map((source, at) => {
      const file = anyMedia(source);
      const filename = file.filename ?? `output_${at + 1}.${file.mediaType.split("/")[1] ?? "bin"}`;
      return media.keepContainerFile({
        ...file,
        id: ids.next(OPENAI_IDS.containerFile),
        container,
        path: `/mnt/data/${filename}`,
        filename,
        createdAt: Math.floor(clock() / 1000),
      });
    });
    const outputs = [
      ...(spec.logs === undefined ? [] : [{ type: "logs", logs: spec.logs }]),
      ...files
        .filter((file) => file.mediaType.startsWith("image/"))
        .map((file) => ({ type: "image", url: `data:${file.mediaType};base64,${base64Of(file.bytes)}` })),
    ];
    const withOutputs = request.includes.includes("code_interpreter_call.outputs");
    const item = {
      id,
      type: "code_interpreter_call",
      status: "completed",
      container_id: container,
      code: spec.code,
      outputs: withOutputs ? outputs : null,
    };
    const events = (output_index: number): ToolEvent[] => [
      { type: "response.code_interpreter_call.in_progress", data: { output_index, item_id: id } },
      {
        type: "response.code_interpreter_call_code.delta",
        data: { output_index, item_id: id, delta: spec.code },
        content: true,
      },
      { type: "response.code_interpreter_call_code.done", data: { output_index, item_id: id, code: spec.code } },
      { type: "response.code_interpreter_call.interpreting", data: { output_index, item_id: id } },
      { type: "response.code_interpreter_call.completed", data: { output_index, item_id: id } },
    ];
    return {
      type: "code_interpreter",
      hosted: true,
      name: "code_interpreter",
      arguments: { code: spec.code },
      id,
      result: [spec.logs ?? "", ...files.map((file) => file.path)].filter((line) => line !== "").join("\n"),
      items: [
        {
          item,
          added: { ...item, status: "in_progress", code: "", outputs: null },
          events,
        },
      ],
      ids: [id, container, ...files.map((file) => file.id)],
      text: spec.code,
    };
  },
};
