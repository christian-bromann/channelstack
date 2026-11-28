import { z } from "@hono/zod-openapi";

import { textPattern } from "../../core/router/inspect.ts";

/** A length of time inside a turn: milliseconds, or `"5s"`, `"100ms"`, `"1m"` (turns are values the SDKs send as they are). */
const duration = (description: string) =>
  z
    .union([z.number().int().min(0), z.string().regex(/^\d+(\.\d+)?(ms|s|m)$/)])
    .transform((value) => {
      if (typeof value === "number") return value;
      const amount = Number.parseFloat(value);
      return Math.round(value.endsWith("ms") ? amount : value.endsWith("s") ? amount * 1000 : amount * 60_000);
    })
    .openapi({ description });

/** Every error a script can answer with: OpenAI's documented ones, by the name a test uses. */
const ERROR_KINDS = [
  "rate_limit",
  "slow_down",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "server_error",
  "overloaded",
  "timeout",
  "context_length_exceeded",
  "content_policy",
  "invalid_api_key",
  "not_in_organization",
  "ip_not_authorized",
  "unsupported_region",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const ENDPOINTS = ["chat.completions", "responses"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

const Timing = z
  .object({
    firstToken: duration(
      "From the request's arrival to the response headers and the first chunk (the whole body if not streaming).",
    ).optional(),
    betweenChunks: duration("Between the chunks of a stream.").optional(),
  })
  .openapi("OpenAITiming");

const ToolCallSpec = z
  .object({
    name: z.string().min(1).openapi({ description: "The tool's name: a function, or a custom tool." }),
    arguments: z
      .union([z.record(z.string(), z.unknown()), z.string()])
      .optional()
      .openapi({ description: "A function's arguments: an object, or the JSON text exactly as the model sends it." }),
    input: z.string().optional().openapi({ description: "A custom tool's free-form input." }),
  })
  .openapi("OpenAIToolCallSpec");

/**
 * What the model answers one call with: text (chunks), tool calls, reasoning, a refusal, or an
 * error. One shape for both endpoints: the agent's request decides the wire format.
 */
export const TurnObject = z
  .object({
    text: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        description:
          "The answer. Streamed, a string goes in chunks of about four characters; an array gives the chunks exactly. Templates: `{lastUserText}`, `{toolResult}`, `{toolResult.<name>}`, `{model}`, `{call}`",
      }),
    toolCalls: z
      .array(ToolCallSpec)
      .optional()
      .openapi({ description: "Tool calls, in order: more than one is parallel." }),
    reasoning: z
      .object({
        summary: z.union([z.string(), z.array(z.string())]).optional(),
        tokens: z.number().int().min(0).optional(),
      })
      .optional()
      .openapi({
        description:
          "Responses: a reasoning item with this summary. Chat Completions: only the reasoning token count (OpenRouter's and DeepSeek's dialects send the summary too).",
      }),
    refusal: z.string().optional(),
    finish: z.enum(["stop", "length", "content_filter"]).optional(),
    usage: z
      .object({
        input: z.number().int().min(0).optional(),
        output: z.number().int().min(0).optional(),
        reasoning: z.number().int().min(0).optional(),
        cached: z.number().int().min(0).optional(),
      })
      .optional()
      .openapi({ description: "Default: counted from the request and the answer, at about four characters a token." }),
    timing: Timing.optional(),
    failAfter: z
      .object({
        chunks: z.number().int().min(0),
        how: z.enum(["error", "drop", "stall"]).default("error"),
      })
      .optional()
      .openapi({ description: "Break a stream after this many chunks: an error event, a cut connection, or a stall." }),
    pauseAfter: z
      .number()
      .int()
      .min(0)
      .optional()
      .openapi({ description: "Hold a stream after this many chunks until the script's `resume()`." }),
    error: z
      .enum(ERROR_KINDS)
      .optional()
      .openapi({ description: "An error the API answers with instead: OpenAI's documented errors." }),
    retryAfter: duration("For an error: what `retry-after` and `retry-after-ms` say. Default 0.").optional(),
    shouldRetry: z
      .boolean()
      .optional()
      .openapi({ description: "For an error: `x-should-retry`, which the SDKs obey." }),
    message: z.string().optional().openapi({ description: "For an error: its message instead of OpenAI's." }),
  })
  .openapi("OpenAITurn");

/** A turn as a test gives it: plain text, or the whole turn. */
export const TurnSchema = z.union([z.string(), TurnObject]).openapi("OpenAITurnInput");

export type TurnInput = z.infer<typeof TurnSchema>;
export type Turn = z.infer<typeof TurnObject>;

/** A turn as the scripts keep it: always the whole object. */
export const turnOf = (input: TurnInput): Turn => (typeof input === "string" ? { text: input } : input);

/** Which calls a script answers: every field given must hold. */
export const MatchSchema = z
  .object({
    text: textPattern().optional().openapi({ description: "In the newest user message (a string ignores case)." }),
    prompt: textPattern()
      .optional()
      .openapi({ description: "Anywhere in the request: instructions, history, tool results." }),
    tools: z.array(z.string()).optional().openapi({ description: "The request offers all of these tools." }),
    toolResult: z
      .union([z.boolean(), z.string()])
      .optional()
      .openapi({ description: "The newest input is a tool result: any (`true`), or of this tool." }),
    endpoint: z.enum(ENDPOINTS).optional(),
    model: textPattern().optional(),
    stream: z.boolean().optional(),
    from: z
      .string()
      .optional()
      .openapi({
        description: "The call answers this person's message: a person of any channel.",
        "x-channelstack-ref-role": ["user"],
      }),
    in: z
      .string()
      .optional()
      .openapi({
        description:
          "The call answers a message in this place (a channel, an issue, a thread of email), or the thread with this id.",
        "x-channelstack-ref-role": ["resource"],
      }),
  })
  .openapi("OpenAIMatch");

export type Match = z.infer<typeof MatchSchema>;
