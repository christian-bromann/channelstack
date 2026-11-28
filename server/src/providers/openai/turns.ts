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

/** The endpoints a call can come to: the model's two, and the media endpoints (design §5.5). */
export const ENDPOINTS = [
  "chat.completions",
  "responses",
  "images.generations",
  "images.edits",
  "audio.speech",
  "audio.transcriptions",
  "audio.translations",
] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/**
 * Media in an answer, as the SDK sends it: a file's bytes (the SDK reads a path in the test
 * process), or a placeholder the fake makes: a PNG of a size, or WAV or PCM silence of a length.
 */
export const MediaSourceSchema = z
  .union([
    z.object({
      content: z.base64().openapi({ description: "The bytes, in base64." }),
      name: z.string().optional().openapi({ description: "The file's name, when it was read from a path." }),
    }),
    z.object({
      placeholder: z.object({
        width: z.number().int().min(1).max(4096).optional(),
        height: z.number().int().min(1).max(4096).optional(),
        seconds: z.number().min(0).max(600).optional(),
      }),
    }),
  ])
  .openapi("OpenAIMediaSource", {
    "x-channelstack-files": "media",
    description:
      "A path (read in the test process), bytes, or `{ placeholder: { width, height } }` (a PNG) or `{ placeholder: { seconds } }` (WAV or PCM silence).",
  });
export type MediaSource = z.infer<typeof MediaSourceSchema>;

const Timing = z
  .object({
    firstToken: duration(
      "From the request's arrival to the response headers and the first chunk (the whole body if not streaming).",
    ).optional(),
    betweenChunks: duration("Between the chunks of a stream.").optional(),
  })
  .openapi("OpenAITiming");

/** The built-in tools a turn can call, by their key in a tool call. */
export const BUILT_IN_KINDS = [
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "imageGeneration",
  "mcp",
  "shell",
  "computer",
  "applyPatch",
] as const;
export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];

/** A computer action, as OpenAI's `computer_call` gives it (`click`, `type`, `screenshot`, …). */
const ComputerAction = z.looseObject({ type: z.string().min(1) }).openapi("OpenAIComputerAction");

/** A file operation of `apply_patch`: create, update or delete, with a diff for the first two. */
const PatchOperation = z
  .object({
    type: z.enum(["create_file", "update_file", "delete_file"]),
    path: z.string().min(1),
    diff: z.string().optional(),
  })
  .openapi("OpenAIPatchOperation");

/**
 * A tool call in an answer: a function (`name`, `arguments`), a custom tool (`name`, `input`), or
 * one of OpenAI's built-in tools (design §5.6). The fake runs none of them: what a hosted tool
 * found is what the script says, and a client-run tool's result is what the agent sends back.
 */
const ToolCallSpec = z
  .object({
    name: z.string().min(1).optional().openapi({ description: "The tool's name: a function, or a custom tool." }),
    arguments: z
      .union([z.record(z.string(), z.unknown()), z.string()])
      .optional()
      .openapi({ description: "A function's arguments: an object, or the JSON text exactly as the model sends it." }),
    input: z.string().optional().openapi({ description: "A custom tool's free-form input." }),
    webSearch: z
      .object({
        query: z.string(),
        action: z.enum(["search", "open_page", "find_in_page"]).default("search"),
        url: z.string().optional().openapi({ description: "For `open_page` and `find_in_page`." }),
        pattern: z.string().optional().openapi({ description: "For `find_in_page`." }),
        sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional(),
      })
      .optional()
      .openapi({ description: "`web_search`, run by OpenAI: its query and what it found." }),
    fileSearch: z
      .object({
        queries: z.array(z.string()).min(1),
        results: z
          .array(
            z.object({
              file: z.string().openapi({ description: "The file's id (`file-…`) or name." }),
              text: z.string(),
              score: z.number().optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .openapi({ description: "`file_search`, run by OpenAI: its queries and what it found." }),
    codeInterpreter: z
      .object({
        code: z.string(),
        logs: z.string().optional(),
        files: z
          .array(MediaSourceSchema)
          .optional()
          .openapi({ description: "Files the code wrote: downloadable from the container." }),
      })
      .optional()
      .openapi({ description: "`code_interpreter`, run by OpenAI in a container." }),
    imageGeneration: z
      .object({ image: MediaSourceSchema, revisedPrompt: z.string().optional() })
      .optional()
      .openapi({ description: "`image_generation`, run by OpenAI." }),
    mcp: z
      .object({
        server: z.string().openapi({ description: "The request's `server_label`." }),
        tool: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        output: z.string().optional(),
        error: z.string().optional(),
        approval: z
          .boolean()
          .optional()
          .openapi({ description: "Ask for approval first: an `mcp_approval_request` instead of the call." }),
      })
      .optional()
      .openapi({ description: "A remote MCP server's tool, called by OpenAI." }),
    shell: z
      .object({
        commands: z.array(z.string()).min(1),
        output: z.string().optional().openapi({ description: "What it printed, when the request's shell is hosted." }),
      })
      .optional()
      .openapi({ description: "`shell`: run by OpenAI in a container, or by the agent (`local`)." }),
    computer: z
      .object({ actions: z.array(ComputerAction).min(1) })
      .optional()
      .openapi({ description: "`computer`, run by the agent, which sends back a screenshot." }),
    applyPatch: z
      .object({ operations: z.array(PatchOperation).min(1) })
      .optional()
      .openapi({ description: "`apply_patch`, run by the agent." }),
  })
  .superRefine((spec, ctx) => {
    const kinds = BUILT_IN_KINDS.filter((kind) => spec[kind] !== undefined);
    if (kinds.length > 1 || (kinds.length === 1 && spec.name !== undefined))
      ctx.addIssue({ code: "custom", message: "A tool call is one tool: a name, or one built-in tool" });
    if (kinds.length === 0 && spec.name === undefined)
      ctx.addIssue({ code: "custom", message: "A tool call needs a name, or a built-in tool" });
  })
  .openapi("OpenAIToolCallSpec");

export type ToolCallInput = z.infer<typeof ToolCallSpec>;

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
    citations: z
      .array(
        z.object({
          quote: z.string().min(1).openapi({ description: "The text the citation marks: its first occurrence." }),
          url: z.string().optional(),
          title: z.string().optional(),
          file: z.string().optional().openapi({ description: "A file's id (`file-…`), or a container file's name." }),
        }),
      )
      .optional()
      .openapi({ description: "Citations on the text, after a web or file search." }),
    image: z.array(MediaSourceSchema).min(1).optional().openapi({
      "x-channelstack-one-or-many": true,
      description: "The Images API's answer: one image, or one per `n`.",
    }),
    // `audio.speech`'s answer, or Chat Completions' audio output with `text` as its transcript.
    audio: MediaSourceSchema.optional(),
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
    approval: z
      .boolean()
      .optional()
      .openapi({ description: "The newest input is an MCP approval response: approving (true) or not (false)." }),
  })
  .openapi("OpenAIMatch");

export type Match = z.infer<typeof MatchSchema>;
