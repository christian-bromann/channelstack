import type { ModelRequest } from "../request.ts";

/** A tool call in an answer, its id minted and its arguments as the JSON text the model sends. */
interface AnswerToolCall {
  readonly id: string;
  /** The item's own id on Responses (`fc_…`, `ctc_…`). */
  readonly itemId: string;
  readonly name: string;
  readonly kind: "function" | "custom";
  /** A function's arguments as JSON text, or a custom tool's input. */
  readonly arguments: string;
}

/** What the model answers one call with, decided before the first byte is sent. Only the transport is paced. */
export interface Answer {
  readonly text: string;
  /** The text in the pieces a stream sends. */
  readonly chunks: readonly string[];
  readonly toolCalls: readonly AnswerToolCall[];
  readonly reasoning?: { readonly itemId: string; readonly summary: readonly string[]; readonly tokens: number };
  readonly refusal?: string;
  readonly finish: "stop" | "length" | "content_filter" | "tool_calls";
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cached: number;
  };
  /** The message item's id on Responses. */
  readonly messageId: string;
}

/** About four characters a token: numbers that grow with the text, without a tokenizer. */
const tokens = (text: string): number => Math.ceil(text.length / 4);

/** Text in the pieces a stream sends: about four characters each. */
export const textChunks = (text: string): string[] => text.match(/[\s\S]{1,4}/g) ?? [];

/**
 * JSON text in pieces split only between tokens, never inside a string, each at least eight
 * characters: every prefix is safe for the partial-JSON parsers agents use.
 */
export function jsonChunks(json: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let at = 0; at < json.length; at += 1) {
    const char = json[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if ("{[,:}]".includes(char ?? "") && at + 1 - start >= 8) {
      pieces.push(json.slice(start, at + 1));
      start = at + 1;
    }
  }
  if (start < json.length) pieces.push(json.slice(start));
  return pieces;
}

/** The usage of an answer: counted from the request's text and the answer's, unless the turn gives it. */
export function usageOf(
  requestText: string,
  answer: Pick<Answer, "text" | "toolCalls" | "refusal">,
  reasoning: number,
  given: {
    input?: number | undefined;
    output?: number | undefined;
    reasoning?: number | undefined;
    cached?: number | undefined;
  } = {},
): Answer["usage"] {
  const produced =
    answer.text + (answer.refusal ?? "") + answer.toolCalls.map((call) => call.name + call.arguments).join("");
  const reasoningTokens = given.reasoning ?? reasoning;
  return {
    input: given.input ?? tokens(requestText),
    output: given.output ?? tokens(produced) + reasoningTokens,
    reasoning: reasoningTokens,
    cached: given.cached ?? 0,
  };
}

/** A dialect of Chat Completions a gateway speaks, picked by the request (decision 0029). */
export type ChatDialect = "openai" | "openrouter" | "deepseek";

export function chatDialect(request: ModelRequest, body: Record<string, unknown>): ChatDialect {
  if (/^deepseek-r/i.test(request.model) || request.model === "deepseek-reasoner") return "deepseek";
  if (typeof body.reasoning === "object" && body.reasoning !== null) return "openrouter";
  return "openai";
}
