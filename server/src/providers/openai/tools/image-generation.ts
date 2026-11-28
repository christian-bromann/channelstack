import { OPENAI_IDS } from "../ids.ts";
import { answerMedia, base64Of } from "../media.ts";
import { type BuiltInTool, type ToolEvent } from "./shared.ts";

/**
 * `image_generation`, run by OpenAI: an `image_generation_call` with the base64 image in the
 * tool's `output_format` (PNG by default), and partial images when `partial_images` asks for them.
 */
export const imageGeneration: BuiltInTool<"imageGeneration"> = {
  kind: "imageGeneration",
  types: ["image_generation"],
  build(spec, { ids, tool }) {
    const settings = tool.settings ?? {};
    const format = typeof settings.output_format === "string" ? settings.output_format : "png";
    const image = answerMedia(spec.image, format, "the generated image");
    if ("problem" in image) return { problem: `called \`image_generation\`, but ${image.problem}` };
    const id = ids.next(OPENAI_IDS.imageGeneration);
    const result = base64Of(image.bytes);
    const size = typeof settings.size === "string" && settings.size !== "auto" ? settings.size : "1024x1024";
    const quality = typeof settings.quality === "string" && settings.quality !== "auto" ? settings.quality : "medium";
    const background =
      typeof settings.background === "string" && settings.background !== "auto" ? settings.background : "opaque";
    const item = {
      id,
      type: "image_generation_call",
      status: "completed",
      result,
      action: "generate",
      size,
      quality,
      background,
      output_format: format,
      revised_prompt: spec.revisedPrompt ?? null,
    };
    const partials = typeof settings.partial_images === "number" ? Math.min(3, settings.partial_images) : 0;
    const events = (output_index: number): ToolEvent[] => [
      { type: "response.image_generation_call.in_progress", data: { output_index, item_id: id } },
      { type: "response.image_generation_call.generating", data: { output_index, item_id: id } },
      ...Array.from({ length: partials }, (_, partial_image_index) => ({
        type: "response.image_generation_call.partial_image",
        data: {
          output_index,
          item_id: id,
          partial_image_index,
          partial_image_b64: result,
          size,
          quality,
          background,
          output_format: format,
        },
        content: true,
      })),
      { type: "response.image_generation_call.completed", data: { output_index, item_id: id }, content: true },
    ];
    return {
      type: "image_generation",
      hosted: true,
      name: "image_generation",
      arguments: spec.revisedPrompt === undefined ? {} : { prompt: spec.revisedPrompt },
      id,
      result: `an image (${image.mediaType}, ${image.bytes.length} bytes)`,
      items: [{ item, added: { ...item, status: "in_progress", result: null }, events }],
      ids: [id],
      text: spec.revisedPrompt ?? "",
    };
  },
};
