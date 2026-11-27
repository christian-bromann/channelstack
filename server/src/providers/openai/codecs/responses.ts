import { randomString } from "../../../core/secrets/index.ts";
import type { SseFrame } from "../../../core/stream/index.ts";
import type { OpenAIError } from "../errors.ts";
import { type Answer, jsonChunks } from "./answer.ts";

/** What the response object repeats of its request. */
export interface ResponseMeta {
  readonly id: string;
  /** Seconds since the epoch. */
  readonly created: number;
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly previousResponseId?: string;
  readonly conversation?: string;
  readonly store: boolean;
  /** `include: ["reasoning.encrypted_content"]`: the opaque blob the agent may send back. */
  readonly encryptedReasoning?: string;
  readonly obfuscation: boolean;
}

/** The output items of an answer, finished. */
export function outputItems(answer: Answer, meta: Pick<ResponseMeta, "encryptedReasoning">): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (answer.reasoning) {
    items.push({
      id: answer.reasoning.itemId,
      type: "reasoning",
      summary:
        answer.reasoning.summary.length === 0
          ? []
          : [{ type: "summary_text", text: answer.reasoning.summary.join("") }],
      ...(meta.encryptedReasoning === undefined ? {} : { encrypted_content: meta.encryptedReasoning }),
    });
  }
  if (answer.refusal !== undefined || answer.text !== "" || answer.toolCalls.length === 0) {
    items.push(messageItem(answer, "completed"));
  }
  for (const call of answer.toolCalls) items.push(callItem(call, "completed"));
  return items;
}

const contentPart = (answer: Answer) =>
  answer.refusal !== undefined
    ? { type: "refusal", refusal: answer.refusal }
    : { type: "output_text", text: answer.text, annotations: [], logprobs: [] };

const messageItem = (answer: Answer, status: string, empty = false) => ({
  id: answer.messageId,
  type: "message",
  status,
  role: "assistant",
  content: empty ? [] : [contentPart(answer)],
});

const callItem = (call: Answer["toolCalls"][number], status: string, empty = false) =>
  call.kind === "custom"
    ? {
        id: call.itemId,
        type: "custom_tool_call",
        status,
        call_id: call.id,
        name: call.name,
        input: empty ? "" : call.arguments,
      }
    : {
        id: call.itemId,
        type: "function_call",
        status,
        call_id: call.id,
        name: call.name,
        arguments: empty ? "" : call.arguments,
      };

/** A `response` object, in a given state. */
export function responseObject(
  answer: Answer | undefined,
  meta: ResponseMeta,
  status: "in_progress" | "completed" | "incomplete" | "failed",
  error?: OpenAIError,
): Record<string, unknown> {
  const { body } = meta;
  const done = status !== "in_progress" && answer !== undefined;
  return {
    id: meta.id,
    object: "response",
    created_at: meta.created,
    // The access programs the request was resolved under: the standard one, as for any model without a tier.
    access_programs: { cyber: "standard" },
    status,
    background: false,
    error: error ? { code: error.code ?? error.type, message: error.message } : null,
    incomplete_details:
      status === "incomplete"
        ? { reason: answer?.finish === "content_filter" ? "content_filter" : "max_output_tokens" }
        : null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    max_tool_calls: body.max_tool_calls ?? null,
    model: meta.model,
    output: done ? outputItems(answer, meta) : [],
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: meta.previousResponseId ?? null,
    ...(meta.conversation === undefined ? {} : { conversation: { id: meta.conversation } }),
    prompt_cache_key: body.prompt_cache_key ?? null,
    reasoning: {
      effort: (body.reasoning as { effort?: unknown } | undefined)?.effort ?? null,
      summary: (body.reasoning as { summary?: unknown } | undefined)?.summary ?? null,
    },
    safety_identifier: body.safety_identifier ?? null,
    service_tier: "default",
    store: meta.store,
    temperature: body.temperature ?? 1,
    text: { format: (body.text as { format?: unknown } | undefined)?.format ?? { type: "text" }, verbosity: "medium" },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_logprobs: 0,
    top_p: body.top_p ?? 1,
    truncation: body.truncation ?? "disabled",
    usage: done
      ? {
          input_tokens: answer.usage.input,
          input_tokens_details: { cached_tokens: answer.usage.cached, cache_write_tokens: 0 },
          output_tokens: answer.usage.output,
          output_tokens_details: { reasoning_tokens: answer.usage.reasoning },
          total_tokens: answer.usage.input + answer.usage.output,
        }
      : null,
    user: body.user ?? null,
    metadata: body.metadata ?? {},
  };
}

/** The status a finished answer gives its response. */
export const finalStatus = (answer: Answer): "completed" | "incomplete" =>
  answer.finish === "length" || answer.finish === "content_filter" ? "incomplete" : "completed";

/** Padding that makes every delta's length uninformative, as OpenAI adds unless `include_obfuscation: false`. */
const obfuscation = () => randomString(16, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

/**
 * The events of an answer, each with its `sequence_number`: `response.created` and
 * `response.in_progress`, each output item added, its content streamed and done, then
 * `response.completed` (or `response.incomplete`).
 */
export function responseFrames(answer: Answer, meta: ResponseMeta): SseFrame[] {
  let sequence = 0;
  const frames: SseFrame[] = [];
  const emit = (type: string, data: Record<string, unknown>, content = false) => {
    frames.push({ event: type, data: JSON.stringify({ type, sequence_number: sequence++, ...data }), content });
  };
  const pad = () => (meta.obfuscation ? { obfuscation: obfuscation() } : {});
  emit("response.created", { response: responseObject(answer, meta, "in_progress") });
  emit("response.in_progress", { response: responseObject(answer, meta, "in_progress") });
  let index = 0;
  const finished = outputItems(answer, meta);
  if (answer.reasoning) {
    const output_index = index;
    const item_id = answer.reasoning.itemId;
    emit("response.output_item.added", { output_index, item: { id: item_id, type: "reasoning", summary: [] } });
    answer.reasoning.summary.forEach((piece, summary_index) => {
      emit("response.reasoning_summary_part.added", {
        item_id,
        output_index,
        summary_index,
        part: { type: "summary_text", text: "" },
      });
      emit(
        "response.reasoning_summary_text.delta",
        { item_id, output_index, summary_index, delta: piece, ...pad() },
        true,
      );
      emit("response.reasoning_summary_text.done", { item_id, output_index, summary_index, text: piece });
      emit("response.reasoning_summary_part.done", {
        item_id,
        output_index,
        summary_index,
        part: { type: "summary_text", text: piece },
      });
    });
    emit("response.output_item.done", { output_index, item: finished[index] });
    index += 1;
  }
  if (answer.refusal !== undefined || answer.text !== "" || answer.toolCalls.length === 0) {
    const output_index = index;
    const item_id = answer.messageId;
    emit("response.output_item.added", { output_index, item: messageItem(answer, "in_progress", true) });
    const part = contentPart(answer);
    const empty =
      answer.refusal !== undefined
        ? { type: "refusal", refusal: "" }
        : { type: "output_text", text: "", annotations: [], logprobs: [] };
    emit("response.content_part.added", { item_id, output_index, content_index: 0, part: empty });
    if (answer.refusal !== undefined) {
      for (const delta of answer.refusal.match(/[\s\S]{1,4}/g) ?? []) {
        emit("response.refusal.delta", { item_id, output_index, content_index: 0, delta }, true);
      }
      emit("response.refusal.done", { item_id, output_index, content_index: 0, refusal: answer.refusal });
    } else {
      for (const delta of answer.chunks) {
        emit(
          "response.output_text.delta",
          { item_id, output_index, content_index: 0, delta, logprobs: [], ...pad() },
          true,
        );
      }
      emit("response.output_text.done", { item_id, output_index, content_index: 0, text: answer.text, logprobs: [] });
    }
    emit("response.content_part.done", { item_id, output_index, content_index: 0, part });
    emit("response.output_item.done", { output_index, item: finished[index] });
    index += 1;
  }
  for (const call of answer.toolCalls) {
    const output_index = index;
    const item_id = call.itemId;
    emit("response.output_item.added", { output_index, item: callItem(call, "in_progress", true) });
    if (call.kind === "custom") {
      emit("response.custom_tool_call_input.delta", { item_id, output_index, delta: call.arguments, ...pad() }, true);
      emit("response.custom_tool_call_input.done", { item_id, output_index, input: call.arguments });
    } else {
      for (const delta of jsonChunks(call.arguments)) {
        emit("response.function_call_arguments.delta", { item_id, output_index, delta, ...pad() }, true);
      }
      emit("response.function_call_arguments.done", {
        item_id,
        output_index,
        name: call.name,
        arguments: call.arguments,
      });
    }
    emit("response.output_item.done", { output_index, item: finished[index] });
    index += 1;
  }
  const status = finalStatus(answer);
  emit(status === "completed" ? "response.completed" : "response.incomplete", {
    response: responseObject(answer, meta, status),
  });
  return frames;
}

/** A stream that fails midway, its events numbered on from `sequence`: an `error` event, then `response.failed`. */
export function responseErrorFrames(meta: ResponseMeta, error: OpenAIError, sequence: number): SseFrame[] {
  let next = sequence;
  const failed = (type: string, data: Record<string, unknown>) => ({
    event: type,
    data: JSON.stringify({ type, sequence_number: next++, ...data }),
  });
  return [
    failed("error", { code: error.code ?? error.type, message: error.message, param: error.param }),
    failed("response.failed", { response: responseObject(undefined, meta, "failed", error) }),
  ];
}
