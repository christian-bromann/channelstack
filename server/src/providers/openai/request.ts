import { invalidRequest, unsupportedInFake } from "./errors.ts";
import type { ModelPart } from "./media.ts";
import { BUILT_IN_TYPES, undated } from "./tools/index.ts";
import type { Endpoint } from "./turns.ts";

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

export interface ModelTool {
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly strict?: boolean;
  /** A built-in tool's settings, as the request gave them (`server_label`, `allowed_tools`, `container`, …). */
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** What a media endpoint's request asks for: the format, the count, the voice. */
export interface MediaOptions {
  /** `response_format`: `b64_json`/`url` for images; the audio format for speech; `json`, `text`, `srt`, … for transcripts. */
  readonly responseFormat?: string;
  /** An image's `output_format` (`png`, `jpeg`, `webp`). */
  readonly outputFormat?: string;
  readonly n: number;
  readonly size?: string;
  readonly quality?: string;
  readonly background?: string;
  readonly voice?: string;
  /** Speech: `audio` or `sse`. */
  readonly streamFormat?: string;
  readonly language?: string;
  /** Images to edit beyond the first, and an edit's mask. */
  readonly images: readonly ModelPart[];
  readonly mask?: ModelPart;
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
  /** The Images API's prompt, or the text speech is made from. */
  readonly prompt?: string;
  /** The audio to transcribe, or the image to edit. */
  readonly file?: ModelPart;
  /** A media endpoint's options. */
  readonly media?: MediaOptions;
  /** Chat Completions' audio output: `modalities: ["text", "audio"]` and its `audio` settings. */
  readonly audioOutput?: { readonly format: string; readonly voice: string };
  /** The MCP approval responses in the request, by the approval request they answer, with its server and tool. */
  readonly approvals: readonly {
    readonly requestId: string;
    readonly approve: boolean;
    readonly server?: string;
    readonly tool?: string;
  }[];
  /** The MCP servers whose tools the conversation has listed (`mcp_list_tools`): they aren't listed again. */
  readonly listedMcp: readonly string[];
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
      case "input_image": {
        const fileId = str(part.file_id);
        parts.push(
          fileId !== undefined
            ? { type: "image", from: "file_id", fileId }
            : { type: "image", ...source(str(part.image_url)) },
        );
        break;
      }
      case "file":
      case "input_file": {
        const file = isObject(part.file) ? part.file : part;
        const fileId = str(file.file_id);
        const filename = str(file.filename);
        const named = filename === undefined ? {} : { filename };
        if (fileId !== undefined) parts.push({ type: "file", from: "file_id", fileId, ...named });
        else if (str(file.file_url) !== undefined)
          parts.push({ type: "file", from: "url", url: str(file.file_url) as string, ...named });
        else parts.push({ type: "file", from: "data", pending: { data: str(file.file_data) ?? "" }, ...named });
        break;
      }
      case "input_audio": {
        const audio = isObject(part.input_audio) ? part.input_audio : part;
        const format = str(audio.format);
        parts.push({
          type: "audio",
          from: "data",
          pending: { data: str(audio.data) ?? "", ...(format === undefined ? {} : { format }) },
        });
        break;
      }
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

const source = (url: string | undefined): Pick<ModelPart, "from" | "url" | "pending"> =>
  url?.startsWith("data:")
    ? { from: "data", pending: { data: url } }
    : { from: "url", ...(url === undefined ? {} : { url }) };

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
  for (const [at, raw] of body.messages.entries()) {
    const where = `messages[${at}]`;
    if (!isObject(raw)) throw invalidRequest(`Invalid type for '${where}': expected an object.`, where);
    const { text, parts } = contentOf(raw.content, `${where}.content`);
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
  const tools = toolsOf(body.tools, "chat");
  const named = nameResults(messages);
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};
  return {
    endpoint: "chat.completions",
    model,
    stream: body.stream === true,
    ...audioOutputOf(body),
    approvals: [],
    listedMcp: [],
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

/** Chat Completions' audio output: asked for with `modalities`, and refused without its `audio` settings, as OpenAI does. */
function audioOutputOf(body: Json): { audioOutput?: NonNullable<ModelRequest["audioOutput"]> } {
  const modalities = Array.isArray(body.modalities) ? body.modalities : [];
  if (!modalities.includes("audio")) return {};
  const audio = isObject(body.audio) ? body.audio : undefined;
  const format = str(audio?.format);
  const voice = str(isObject(audio?.voice) ? audio.voice.id : audio?.voice);
  if (audio === undefined || format === undefined || voice === undefined) {
    throw invalidRequest(
      "Missing required parameter: 'audio'. It is required when 'modalities' includes 'audio'.",
      "audio",
      "missing_required_parameter",
    );
  }
  return { audioOutput: { format, voice } };
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

function toolsOf(tools: unknown, endpoint: "chat" | "responses"): ModelTool[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw invalidRequest("Invalid type for 'tools': expected an array.", "tools");
  return tools.map((tool, at) => {
    if (!isObject(tool)) throw invalidRequest(`Invalid type for 'tools[${at}]': expected an object.`, `tools[${at}]`);
    const type = str(tool.type) ?? "function";
    // OpenAI's built-in tools are on Responses only (design §5.6), each with its settings.
    if (BUILT_IN_TYPES.has(type)) {
      if (endpoint === "chat") {
        throw invalidRequest(
          `Invalid value: '${type}'. Supported values are: 'function' and 'custom'.`,
          `tools[${at}].type`,
          "invalid_value",
        );
      }
      if (type === "mcp" && str(tool.server_label) === undefined) {
        throw invalidRequest(
          `Missing required parameter: 'tools[${at}].server_label'.`,
          `tools[${at}].server_label`,
          "missing_required_parameter",
        );
      }
      const { type: _type, ...settings } = tool;
      return { type: undated(type), settings };
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
  const messages: ModelMessage[] = [];
  const refs: string[] = [];
  const listedMcp: string[] = [];
  const asked = new Map<string, { server: string; tool: string }>();
  const approvals: { requestId: string; approve: boolean; server?: string; tool?: string }[] = [];
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
      case "item_reference":
      case "web_search_call":
      case "file_search_call":
      case "code_interpreter_call":
      case "image_generation_call":
      case "mcp_call":
        if (str(item.id)) refs.push(str(item.id) as string);
        break;
      case "mcp_list_tools":
        if (str(item.id)) refs.push(str(item.id) as string);
        if (str(item.server_label)) listedMcp.push(str(item.server_label) as string);
        break;
      case "mcp_approval_request": {
        const id = str(item.id) ?? "";
        refs.push(id);
        asked.set(id, { server: str(item.server_label) ?? "", tool: str(item.name) ?? "" });
        break;
      }
      case "mcp_approval_response": {
        const requestId = str(item.approval_request_id);
        if (requestId === undefined) {
          throw invalidRequest(
            `Missing required parameter: '${where}.approval_request_id'.`,
            `${where}.approval_request_id`,
            "missing_required_parameter",
          );
        }
        refs.push(requestId);
        const approve = item.approve === true;
        const request = asked.get(requestId);
        approvals.push({ requestId, approve, ...(request ?? {}) });
        // The agent's answer to the approval request, as a tool result is an answer to a call.
        messages.push({
          role: "tool",
          callId: requestId,
          ...(request === undefined ? {} : { name: request.tool }),
          text: approve ? "approved" : `declined${str(item.reason) ? `: ${str(item.reason)}` : ""}`,
        });
        break;
      }
      // The tools the agent runs: their calls, which it may send back, and its outputs.
      case "computer_call":
      case "shell_call":
      case "local_shell_call":
      case "apply_patch_call": {
        const callId = str(item.call_id) ?? "";
        refs.push(callId);
        if (str(item.id)) refs.push(str(item.id) as string);
        const name =
          type === "computer_call"
            ? "computer"
            : type === "apply_patch_call"
              ? "apply_patch"
              : type === "local_shell_call"
                ? "local_shell"
                : "shell";
        const args = item.action ?? item.actions ?? item.operation ?? {};
        const previous = messages.at(-1);
        const call = { id: callId, name, arguments: args };
        if (previous?.role === "assistant" && previous.text === "") {
          messages[messages.length - 1] = { ...previous, toolCalls: [...previous.toolCalls, call] };
        } else messages.push({ role: "assistant", text: "", toolCalls: [call] });
        break;
      }
      case "computer_call_output":
      case "shell_call_output":
      case "local_shell_call_output":
      case "apply_patch_call_output": {
        const callId = str(item.call_id);
        if (callId === undefined) {
          throw invalidRequest(
            `Missing required parameter: '${where}.call_id'.`,
            `${where}.call_id`,
            "missing_required_parameter",
          );
        }
        refs.push(callId);
        messages.push({ role: "tool", callId, text: outputText(type, item) });
        break;
      }
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
    approvals,
    listedMcp,
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

/** What a client-run tool's output says, as text: a shell's output, a patch's result, a screenshot's kind. */
function outputText(type: string, item: Json): string {
  const output = item.output;
  if (type === "shell_call_output" && Array.isArray(output)) {
    return output
      .filter(isObject)
      .map((chunk) =>
        [str(chunk.stdout), str(chunk.stderr)].filter((text) => text !== undefined && text !== "").join("\n"),
      )
      .join("\n");
  }
  if (type === "computer_call_output" && isObject(output)) {
    const url = str(output.image_url);
    return url === undefined ? (str(output.file_id) ?? "") : url.startsWith("data:") ? "a screenshot" : url;
  }
  if (type === "apply_patch_call_output") return str(output) ?? str(item.status) ?? "";
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
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

/** The formats each media endpoint answers in, by its `response_format` (the first is the default). */
export const MEDIA_FORMATS = {
  "images.generations": ["b64_json", "url"],
  "images.edits": ["b64_json", "url"],
  "audio.speech": ["mp3", "opus", "aac", "flac", "wav", "pcm"],
  "audio.transcriptions": ["json", "text", "srt", "verbose_json", "vtt", "diarized_json"],
  "audio.translations": ["json", "text", "srt", "verbose_json", "vtt"],
} as const;
type MediaEndpoint = keyof typeof MEDIA_FORMATS;

const IMAGE_FORMATS = ["png", "jpeg", "webp"];

/** The fields every media endpoint needs, refused as OpenAI refuses a request without them. */
const REQUIRED: Readonly<Record<MediaEndpoint, readonly string[]>> = {
  "images.generations": ["prompt"],
  "images.edits": ["prompt"],
  "audio.speech": ["model", "input", "voice"],
  "audio.transcriptions": ["model"],
  "audio.translations": ["model"],
};

/**
 * A media endpoint's request, normalised like a model call: its prompt (or the text to speak) is
 * the user's message, with the file it sends (the audio, the image to edit) as its part.
 * `fields` is the JSON body or the multipart form's fields.
 */
export function mediaRequest(
  endpoint: MediaEndpoint,
  fields: Json,
  files: { file?: ModelPart; images?: readonly ModelPart[]; mask?: ModelPart },
  headers: Headers,
): ModelRequest {
  for (const name of REQUIRED[endpoint]) {
    if (fields[name] === undefined || fields[name] === "") {
      throw invalidRequest(`Missing required parameter: '${name}'.`, name, "missing_required_parameter");
    }
  }
  const [first, ...more] = files.images ?? [];
  const file = files.file ?? first;
  if (endpoint.startsWith("audio.trans") && file === undefined) {
    throw invalidRequest("Missing required parameter: 'file'.", "file", "missing_required_parameter");
  }
  if (endpoint === "images.edits" && file === undefined) {
    throw invalidRequest("Missing required parameter: 'image'.", "image", "missing_required_parameter");
  }
  const allowed: readonly string[] = MEDIA_FORMATS[endpoint];
  const responseFormat = str(fields.response_format) ?? allowed[0];
  if (responseFormat !== undefined && !allowed.includes(responseFormat)) {
    throw invalidRequest(
      `Invalid value: '${responseFormat}'. Supported values are: ${allowed.map((value) => `'${value}'`).join(", ")}.`,
      "response_format",
      "invalid_value",
    );
  }
  const outputFormat = str(fields.output_format);
  if (outputFormat !== undefined && !IMAGE_FORMATS.includes(outputFormat)) {
    throw invalidRequest(
      `Invalid value: '${outputFormat}'. Supported values are: 'png', 'jpeg', and 'webp'.`,
      "output_format",
      "invalid_value",
    );
  }
  const model = str(fields.model) ?? (endpoint.startsWith("images") ? "gpt-image-1" : "");
  const stream = fields.stream === true || fields.stream === "true";
  if (stream && model === "whisper-1") {
    throw invalidRequest("Streaming is not supported for the whisper-1 model.", "stream", "unsupported_value");
  }
  if (stream && endpoint.startsWith("images")) throw unsupportedInFake("streamed images (`stream: true`)", "stream");
  const n = Number(fields.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw invalidRequest(`Invalid value for 'n': ${String(fields.n)}. It must be between 1 and 10.`, "n");
  }
  const prompt = str(fields.prompt) ?? str(fields.input);
  const message: ModelMessage = { role: "user", text: prompt ?? "", parts: file === undefined ? [] : [file] };
  const instructions = str(fields.instructions);
  return {
    endpoint,
    model,
    stream,
    ...withOptional("prompt", prompt),
    ...withOptional("file", file),
    media: {
      ...withOptional("responseFormat", responseFormat),
      ...withOptional("outputFormat", outputFormat),
      n,
      ...withOptional("size", str(fields.size)),
      ...withOptional("quality", str(fields.quality)),
      ...withOptional("background", str(fields.background)),
      ...withOptional("voice", str(isObject(fields.voice) ? fields.voice.id : fields.voice)),
      ...withOptional("streamFormat", str(fields.stream_format)),
      ...withOptional("language", str(fields.language)),
      images: more,
      ...withOptional("mask", files.mask),
    },
    ...(instructions === undefined ? {} : { instructions }),
    approvals: [],
    listedMcp: [],
    messages: [message],
    tools: [],
    ...withOptional("lastUserText", prompt),
    lastToolResults: [],
    tags: tagsOf(fields, headers),
    refs: [],
    includeUsage: false,
    includeObfuscation: false,
    parallelToolCalls: false,
    includes: [],
  };
}
