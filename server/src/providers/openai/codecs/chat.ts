import type { SseFrame } from "../../../core/stream/index.ts";
import type { OpenAIError } from "../errors.ts";
import { type Answer, type ChatDialect, jsonChunks, obfuscation } from "./answer.ts";

/** What every chunk and completion of one answer shares. */
export interface ChatMeta {
  readonly id: string;
  /** Seconds since the epoch. */
  readonly created: number;
  readonly model: string;
  readonly fingerprint: string;
  readonly dialect: ChatDialect;
  /** Every chunk padded with `obfuscation` (`stream_options.include_obfuscation`, on by default). */
  readonly obfuscation: boolean;
}

const usageWire = (usage: Answer["usage"]) => ({
  prompt_tokens: usage.input,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.output,
  prompt_tokens_details: { cached_tokens: usage.cached, audio_tokens: 0 },
  completion_tokens_details: {
    reasoning_tokens: usage.reasoning,
    audio_tokens: 0,
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 0,
  },
});

const toolCallWire = (call: Answer["toolCalls"][number]) =>
  call.kind === "custom"
    ? { id: call.id, type: "custom", custom: { name: call.name, input: call.arguments } }
    : { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };

/** The reasoning summary, in the field the dialect puts it in: OpenAI sends none on Chat Completions. */
const reasoningField = (dialect: ChatDialect, text: string): Record<string, string> =>
  dialect === "openrouter" ? { reasoning: text } : dialect === "deepseek" ? { reasoning_content: text } : {};

/** A whole `chat.completion`. */
export function chatCompletion(answer: Answer, meta: ChatMeta): Record<string, unknown> {
  const reasoning = answer.reasoning?.summary.join("") ?? "";
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            answer.refusal === undefined && (answer.text !== "" || answer.toolCalls.length === 0) ? answer.text : null,
          refusal: answer.refusal ?? null,
          ...(answer.toolCalls.length > 0 ? { tool_calls: answer.toolCalls.map(toolCallWire) } : {}),
          annotations: [],
          ...(reasoning === "" ? {} : reasoningField(meta.dialect, reasoning)),
        },
        logprobs: null,
        finish_reason: answer.finish,
      },
    ],
    usage: usageWire(answer.usage),
    service_tier: "default",
    system_fingerprint: meta.fingerprint,
  };
}

/** One `chat.completion.chunk` with this delta. */
function chunk(
  meta: ChatMeta,
  delta: Record<string, unknown>,
  finish: string | null,
  usage: boolean,
): SseFrame["data"] {
  return JSON.stringify({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    service_tier: "default",
    system_fingerprint: meta.fingerprint,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    ...(usage ? { usage: null } : {}),
    ...(meta.obfuscation ? { obfuscation: obfuscation() } : {}),
  });
}

/**
 * The stream of an answer: a first chunk with the role, the content (or refusal) in its pieces,
 * each tool call's id and name then its arguments in pieces, a chunk with the finish reason, the
 * usage chunk when `include_usage` asks for it, and `[DONE]`.
 */
export function chatFrames(answer: Answer, meta: ChatMeta, includeUsage: boolean): SseFrame[] {
  const frames: SseFrame[] = [];
  const data = (delta: Record<string, unknown>, finish: string | null = null) =>
    chunk(meta, delta, finish, includeUsage);
  frames.push({ data: data({ role: "assistant", content: "", refusal: null }) });
  for (const piece of answer.reasoning?.summary ?? []) {
    if (meta.dialect !== "openai") frames.push({ data: data(reasoningField(meta.dialect, piece)), content: true });
  }
  if (answer.refusal !== undefined) {
    for (const piece of answer.refusal.match(/[\s\S]{1,4}/g) ?? [])
      frames.push({ data: data({ refusal: piece }), content: true });
  } else {
    for (const piece of answer.chunks) frames.push({ data: data({ content: piece }), content: true });
  }
  answer.toolCalls.forEach((call, index) => {
    const opening =
      call.kind === "custom"
        ? { index, id: call.id, type: "custom", custom: { name: call.name, input: "" } }
        : { index, id: call.id, type: "function", function: { name: call.name, arguments: "" } };
    frames.push({ data: data({ tool_calls: [opening] }), content: true });
    for (const piece of call.kind === "custom" ? [call.arguments] : jsonChunks(call.arguments)) {
      const more =
        call.kind === "custom" ? { index, custom: { input: piece } } : { index, function: { arguments: piece } };
      frames.push({ data: data({ tool_calls: [more] }), content: true });
    }
  });
  frames.push({ data: data({}, answer.finish) });
  if (includeUsage) {
    frames.push({
      data: JSON.stringify({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        service_tier: "default",
        system_fingerprint: meta.fingerprint,
        choices: [],
        usage: usageWire(answer.usage),
        ...(meta.obfuscation ? { obfuscation: obfuscation() } : {}),
      }),
    });
  }
  frames.push({ data: "[DONE]" });
  return frames;
}

/** A stream that fails midway: OpenAI sends the error as a data line, and the SDKs throw on it. */
export const chatErrorFrames = (error: OpenAIError): SseFrame[] => [{ data: JSON.stringify(error.body()) }];
