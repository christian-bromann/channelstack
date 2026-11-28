import { invalidRequest, unsupportedInFake } from "./errors.ts";
import type { Endpoint } from "./turns.ts";

/** An image, file or audio part the agent sent (phase 14 reads their bytes; phase 13 records that they were there). */
interface ModelPart {
  readonly type: "image" | "file" | "audio";
  readonly from: "data" | "file_id" | "url";
  readonly url?: string;
}

interface ModelToolCallRef {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** One message of the conversation, the same for both endpoints. */
type ModelMessage =
  | { readonly role: "system" | "developer"; readonly text: string }
  | { readonly role: "user"; readonly text: string; readonly parts: readonly ModelPart[] }
  | { readonly role: "assistant"; readonly text: string; readonly toolCalls: readonly ModelToolCallRef[] }
  | { readonly role: "tool"; readonly callId: string; readonly name?: string; readonly text: string };

interface ModelTool {
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly strict?: boolean;
}

type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json_object" }
  | { readonly type: "json_schema"; readonly name: string; readonly schema: unknown; readonly strict?: boolean };

/** A model call, normalised: the same shape for Chat Completions and Responses. */
export interface ModelRequest {
  readonly endpoint: Endpoint;
  readonly model: string;
  readonly stream: boolean;
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly toolChoice?: "auto" | "none" | "required" | { readonly name: string };
  readonly responseFormat?: ResponseFormat;
  readonly reasoning?: { readonly effort?: string; readonly summary?: string };
  readonly lastUserText?: string;
  readonly lastToolResults: readonly { readonly callId: string; readonly name?: string; readonly text: string }[];
  /** Values the agent tagged the call with: `user`, `safety_identifier`, `prompt_cache_key`, metadata. */
  readonly tags: readonly string[];
  /** Ids from earlier answers that the request carries: tool call ids, `previous_response_id`. */
  readonly refs: readonly string[];
  readonly maxOutputTokens?: number;
  readonly includeUsage: boolean;
  readonly includeObfuscation: boolean;
  readonly parallelToolCalls: boolean;
  readonly includes: readonly string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A message's content as text, and its other parts: a string, or a list of parts. */
function contentOf(content: unknown, where: string): { text: string; parts: ModelPart[] } {
  if (content === undefined || content === null) return { text: "", parts: [] };
  if (typeof content === "string") return { text: content, parts: [] };
  if (!Array.isArray(content))
    throw invalidRequest(`Invalid type for '${where}': expected a string or an array.`, where);
  const texts: string[] = [];
  const parts: ModelPart[] = [];
  for (const [at, part] of content.entries()) {
    if (!isObject(part))
      throw invalidRequest(`Invalid type for '${where}[${at}]': expected an object.`, `${where}[${at}]`);
    switch (part.type) {
      case "text":
      case "input_text":
      case "output_text":
        texts.push(str(part.text) ?? "");
        break;
      case "refusal":
        texts.push(str(part.refusal) ?? "");
        break;
      case "image_url": {
        const url = isObject(part.image_url) ? str(part.image_url.url) : undefined;
        parts.push({ type: "image", ...source(url) });
        break;
      }
      case "input_image":
        parts.push(
          part.file_id !== undefined
            ? { type: "image", from: "file_id" }
            : { type: "image", ...source(str(part.image_url)) },
        );
        break;
      case "file":
      case "input_file":
        parts.push({
          type: "file",
          from: (isObject(part.file) ? part.file.file_id : part.file_id) !== undefined ? "file_id" : "data",
        });
        break;
      case "input_audio":
        parts.push({ type: "audio", from: "data" });
        break;
      default:
        throw invalidRequest(
          `Invalid value: '${String(part.type)}'. Supported values are: 'text', 'image_url', 'input_audio', 'refusal', and 'file'.`,
          `${where}[${at}].type`,
          "invalid_value",
        );
    }
  }
  return { text: texts.join("\n"), parts };
}

const source = (url: string | undefined): Pick<ModelPart, "from" | "url"> =>
  url?.startsWith("data:") ? { from: "data" } : { from: "url", ...(url === undefined ? {} : { url }) };

const parseArguments = (text: unknown): unknown => {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** What every request may tag itself with: OpenAI's own fields for who is asking, and metadata. */
function tagsOf(body: Json, headers: Headers): string[] {
  const tags = [str(body.user), str(body.safety_identifier), str(body.prompt_cache_key)];
  if (isObject(body.metadata)) tags.push(...Object.values(body.metadata).map(str));
  tags.push(headers.get("x-channelstack-session") ?? undefined);
  return tags.filter((tag): tag is string => tag !== undefined && tag !== "");
}

function lastUser(messages: readonly ModelMessage[]): string | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "user") return message.text;
  }
  return undefined;
}

/** The tool results after the last assistant turn: what the agent sent back for the model's calls. */
function lastToolResults(messages: readonly ModelMessage[]): ModelRequest["lastToolResults"] {
  const results: { callId: string; name?: string; text: string }[] = [];
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role !== "tool") break;
    results.unshift({
      callId: message.callId,
      ...(message.name === undefined ? {} : { name: message.name }),
      text: message.text,
    });
  }
  return results;
}

/** A tool result names its tool by the call it answers. */
function nameResults(messages: ModelMessage[]): ModelMessage[] {
  const names = new Map<string, string>();
  return messages.map((message) => {
    if (message.role === "assistant") for (const call of message.toolCalls) names.set(call.id, call.name);
    if (message.role === "tool" && message.name === undefined) {
      const name = names.get(message.callId);
      return name === undefined ? message : { ...message, name };
    }
    return message;
  });
}

/** A Chat Completions request, normalised, refused as OpenAI refuses it when it can't be one. */
export function chatRequest(body: Json, headers: Headers): ModelRequest {
  const model = str(body.model);
  if (model === undefined || model === "") throw invalidRequest("you must provide a model parameter", null);
  if (!Array.isArray(body.messages)) {
    throw invalidRequest("Missing required parameter: 'messages'.", "messages", "missing_required_parameter");
  }
  const n = body.n ?? 1;
  if (n !== 1) throw unsupportedInFake("`n` other than 1", "n");
  const messages: ModelMessage[] = [];
  const toolCallIds = new Set<string>();
  const refs: string[] = [];
  // The newest assistant message's tool calls no `tool` message has answered yet: OpenAI refuses a
  // conversation that goes on, or ends, before each one has its answer.
  let unanswered: { at: number; ids: Set<string> } | undefined;
  const answerFirst = () => {
    if (unanswered === undefined || unanswered.ids.size === 0) return;
    throw invalidRequest(
      `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...unanswered.ids].join(", ")}`,
      `messages[${unanswered.at}].role`,
    );
  };
  for (const [at, raw] of body.messages.entries()) {
    const where = `messages[${at}]`;
    if (!isObject(raw)) throw invalidRequest(`Invalid type for '${where}': expected an object.`, where);
    const { text, parts } = contentOf(raw.content, `${where}.content`);
    if (raw.role !== "tool") answerFirst();
    switch (raw.role) {
      case "system":
      case "developer":
        messages.push({ role: raw.role, text });
        break;
      case "user":
        messages.push({ role: "user", text, parts });
        break;
      case "assistant": {
        const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        const toolCalls = calls.filter(isObject).map((call) => {
          const fn = isObject(call.function) ? call.function : isObject(call.custom) ? call.custom : {};
          const id = str(call.id) ?? "";
          toolCallIds.add(id);
          refs.push(id);
          return { id, name: str(fn.name) ?? "", arguments: parseArguments(fn.arguments ?? fn.input) };
        });
        unanswered = { at, ids: new Set(toolCalls.map((call) => call.id)) };
        messages.push({ role: "assistant", text, toolCalls });
        break;
      }
      case "tool": {
        const callId = str(raw.tool_call_id);
        if (callId === undefined) {
          throw invalidRequest(
            `Missing required parameter: '${where}.tool_call_id'.`,
            `${where}.tool_call_id`,
            "missing_required_parameter",
          );
        }
        if (!toolCallIds.has(callId)) {
          throw invalidRequest(
            "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.",
            `${where}.role`,
          );
        }
        unanswered?.ids.delete(callId);
        messages.push({ role: "tool", callId, text });
        break;
      }
      default:
        throw invalidRequest(
          `Invalid value: '${String(raw.role)}'. Supported values are: 'system', 'assistant', 'user', 'function', 'tool', and 'developer'.`,
          `${where}.role`,
          "invalid_value",
        );
    }
  }
  answerFirst();
  const tools = toolsOf(body.tools, "chat");
  const named = nameResults(messages);
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};
  return {
    endpoint: "chat.completions",
    model,
    stream: body.stream === true,
    ...instructionsOf(named),
    messages: named,
    tools,
    ...toolChoiceOf(body.tool_choice),
    ...formatOf(isObject(body.response_format) ? body.response_format : undefined, "response_format"),
    ...reasoningOf(body),
    ...withOptional("lastUserText", lastUser(named)),
    lastToolResults: lastToolResults(named),
    tags: tagsOf(body, headers),
    refs,
    ...withOptional("maxOutputTokens", numberOf(body.max_completion_tokens ?? body.max_tokens)),
    includeUsage: streamOptions.include_usage === true,
    includeObfuscation: streamOptions.include_obfuscation !== false,
    parallelToolCalls: body.parallel_tool_calls !== false,
    includes: [],
  };
}

/** Reasoning settings: Chat Completions' `reasoning_effort`, or a `reasoning` object (Responses, and OpenRouter's). */
function reasoningOf(body: Json): { reasoning?: NonNullable<ModelRequest["reasoning"]> } {
  const reasoning = isObject(body.reasoning) ? body.reasoning : undefined;
  const effort = str(reasoning?.effort) ?? str(body.reasoning_effort);
  const summary = str(reasoning?.summary);
  if (effort === undefined && summary === undefined) return {};
  return { reasoning: { ...withOptional("effort", effort), ...withOptional("summary", summary) } };
}

const numberOf = (value: unknown) => (typeof value === "number" ? value : undefined);
const withOptional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const instructionsOf = (messages: readonly ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.text)
    .join("\n");
  return text === "" ? {} : { instructions: text };
};

/** Hosted tools come in phase 14; until then they are refused by name. */
const HOSTED = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "code_interpreter",
  "image_generation",
  "mcp",
  "shell",
  "local_shell",
  "computer",
  "computer_use_preview",
  "apply_patch",
]);

function toolsOf(tools: unknown, endpoint: "chat" | "responses"): ModelTool[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw invalidRequest("Invalid type for 'tools': expected an array.", "tools");
  return tools.map((tool, at) => {
    if (!isObject(tool)) throw invalidRequest(`Invalid type for 'tools[${at}]': expected an object.`, `tools[${at}]`);
    const type = str(tool.type) ?? "function";
    if (HOSTED.has(type)) {
      if (endpoint === "chat") {
        throw invalidRequest(
          `Invalid value: '${type}'. Supported values are: 'function' and 'custom'.`,
          `tools[${at}].type`,
          "invalid_value",
        );
      }
      throw unsupportedInFake(`the built-in tool \`${type}\` (phase 14)`, `tools[${at}].type`);
    }
    // Chat Completions nests a tool's definition under its type; Responses doesn't.
    const definition = endpoint === "chat" && isObject(tool[type]) ? (tool[type] as Json) : tool;
    const name = str(definition.name);
    if (name === undefined) {
      throw invalidRequest(
        `Missing required parameter: 'tools[${at}].${endpoint === "chat" ? `${type}.` : ""}name'.`,
        `tools[${at}].name`,
        "missing_required_parameter",
      );
    }
    return {
      type,
      name,
      ...withOptional("description", str(definition.description)),
      ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
      ...(typeof definition.strict === "boolean" ? { strict: definition.strict } : {}),
    };
  });
}

function toolChoiceOf(choice: unknown): { toolChoice?: NonNullable<ModelRequest["toolChoice"]> } {
  if (choice === "auto" || choice === "none" || choice === "required") return { toolChoice: choice };
  if (isObject(choice)) {
    const name = str(choice.name) ?? (isObject(choice.function) ? str(choice.function.name) : undefined);
    if (name !== undefined) return { toolChoice: { name } };
  }
  return {};
}

function formatOf(format: Json | undefined, where: string): { responseFormat?: ResponseFormat } {
  if (format === undefined) return {};
  if (format.type === "json_object") return { responseFormat: { type: "json_object" } };
  if (format.type === "json_schema") {
    // Chat Completions nests it under `json_schema`; Responses' `text.format` doesn't.
    const spec = isObject(format.json_schema) ? format.json_schema : format;
    const name = str(spec.name);
    if (name === undefined) {
      throw invalidRequest(
        `Missing required parameter: '${where}.json_schema.name'.`,
        `${where}.json_schema.name`,
        "missing_required_parameter",
      );
    }
    return {
      responseFormat: {
        type: "json_schema",
        name,
        schema: spec.schema,
        ...(typeof spec.strict === "boolean" ? { strict: spec.strict } : {}),
      },
    };
  }
  return { responseFormat: { type: "text" } };
}

/** A Responses API input item, as the conversation keeps it. */
export type InputItem = Json;

/**
 * A Responses request, normalised. `history` is what comes before its own input: the chain
 * `previous_response_id` names, or the conversation's items.
 */
export function responsesRequest(body: Json, headers: Headers, history: readonly InputItem[]): ModelRequest {
  const model = str(body.model);
  if (model === undefined || model === "") {
    throw invalidRequest("Missing required parameter: 'model'.", "model", "missing_required_parameter");
  }
  if (body.background === true) throw unsupportedInFake("`background: true`", "background");
  const own = inputItems(body.input);
  const items = [...history, ...own];
  // A tool's output answers a call the input, its chain or its conversation holds, as OpenAI requires.
  const calls = new Set(
    items.flatMap((item) =>
      item.type === "function_call" || item.type === "custom_tool_call" ? [str(item.call_id)] : [],
    ),
  );
  const referenced = items.some((item) => item.type === "item_reference");
  const messages: ModelMessage[] = [];
  const refs: string[] = [];
  if (str(body.previous_response_id)) refs.push(str(body.previous_response_id) as string);
  for (const [at, item] of items.entries()) {
    const where = `input[${at - history.length}]`;
    const type = str(item.type) ?? "message";
    switch (type) {
      case "message": {
        const role = str(item.role);
        const { text, parts } = contentOf(item.content, `${where}.content`);
        if (role === "user") messages.push({ role: "user", text, parts });
        else if (role === "system" || role === "developer") messages.push({ role, text });
        else if (role === "assistant") messages.push({ role: "assistant", text, toolCalls: [] });
        else {
          throw invalidRequest(
            `Invalid value: '${String(role)}'. Supported values are: 'assistant', 'system', 'developer', and 'user'.`,
            `${where}.role`,
            "invalid_value",
          );
        }
        if (str(item.id)) refs.push(str(item.id) as string);
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const call = {
          id: str(item.call_id) ?? "",
          name: str(item.name) ?? "",
          arguments: parseArguments(item.arguments ?? item.input),
        };
        refs.push(call.id);
        if (str(item.id)) refs.push(str(item.id) as string);
        const previous = messages.at(-1);
        // Parallel calls are one assistant turn.
        if (previous?.role === "assistant" && previous.text === "") {
          messages[messages.length - 1] = { ...previous, toolCalls: [...previous.toolCalls, call] };
        } else messages.push({ role: "assistant", text: "", toolCalls: [call] });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = str(item.call_id);
        if (callId === undefined) {
          throw invalidRequest(
            `Missing required parameter: '${where}.call_id'.`,
            `${where}.call_id`,
            "missing_required_parameter",
          );
        }
        // A custom tool's call may be an `item_reference` to a stored item; a function's never is.
        if (!calls.has(callId) && (type === "function_call_output" || !referenced)) {
          throw invalidRequest(
            `No tool call found for ${type === "function_call_output" ? "function call" : "custom tool call"} output with call_id ${callId}.`,
            "input",
          );
        }
        refs.push(callId);
        const output = item.output;
        messages.push({
          role: "tool",
          callId,
          text: typeof output === "string" ? output : JSON.stringify(output ?? ""),
        });
        break;
      }
      case "reasoning":
        if (str(item.id)) refs.push(str(item.id) as string);
        break;
      case "item_reference":
        if (str(item.id)) refs.push(str(item.id) as string);
        break;
      default:
        throw unsupportedInFake(`the input item type \`${type}\``, `${where}.type`);
    }
  }
  const instructions = str(body.instructions);
  const named = nameResults(messages);
  const system = instructionsOf(named).instructions;
  const joined = [instructions, system].filter((text) => text !== undefined && text !== "").join("\n");
  const text = isObject(body.text) && isObject(body.text.format) ? body.text.format : undefined;
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};
  return {
    endpoint: "responses",
    model,
    stream: body.stream === true,
    ...(joined === "" ? {} : { instructions: joined }),
    messages: named,
    tools: toolsOf(body.tools, "responses"),
    ...toolChoiceOf(body.tool_choice),
    ...formatOf(text, "text.format"),
    ...reasoningOf(body),
    ...withOptional("lastUserText", lastUser(named)),
    lastToolResults: lastToolResults(named),
    tags: tagsOf(body, headers),
    refs,
    ...withOptional("maxOutputTokens", numberOf(body.max_output_tokens)),
    includeUsage: true,
    includeObfuscation: streamOptions.include_obfuscation !== false,
    parallelToolCalls: body.parallel_tool_calls !== false,
    includes: Array.isArray(body.include)
      ? body.include.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/** `input` as items: a string is one user message. */
export function inputItems(input: unknown): InputItem[] {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  if (!Array.isArray(input)) throw invalidRequest("Invalid type for 'input': expected a string or an array.", "input");
  return input.map((item, at) => {
    if (!isObject(item)) throw invalidRequest(`Invalid type for 'input[${at}]': expected an object.`, `input[${at}]`);
    return item;
  });
}

/** Everything a request says, as one text: for attribution and for `toHaveSent`. */
export function requestText(request: ModelRequest): string {
  const lines = [request.instructions ?? ""];
  for (const message of request.messages) {
    lines.push(message.text);
    if (message.role === "assistant") for (const call of message.toolCalls) lines.push(JSON.stringify(call.arguments));
  }
  return lines.filter((line) => line !== "").join("\n");
}
