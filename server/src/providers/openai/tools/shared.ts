import type { Clock } from "../../../core/clock/index.ts";
import type { IdGenerator } from "../../../core/ids/index.ts";
import type { MediaStore } from "../media.ts";
import type { ModelRequest, ModelTool } from "../request.ts";
import type { BuiltInKind, ToolCallInput } from "../turns.ts";

export type Json = Record<string, unknown>;

/** One event of a built-in item's stream, before the codec numbers it. */
export interface ToolEvent {
  readonly type: string;
  readonly data: Json;
  /** It carries content: timing, breaks and holds count it. */
  readonly content?: boolean;
}

/** One output item a built-in call adds to the answer: finished, as it is first added, and the events between. */
export interface ToolItem {
  readonly item: Json;
  readonly added: Json;
  events(outputIndex: number): ToolEvent[];
}

/** The kinds `toolCalls()` reports, by the tool's `type`. */
export type ToolCallType =
  "web_search" | "file_search" | "code_interpreter" | "image_generation" | "mcp" | "shell" | "computer" | "apply_patch";

/** A built-in tool call of an answer: its items, and what `toolCalls()` says about it. */
export interface BuiltInCall {
  readonly type: ToolCallType;
  /** OpenAI ran it, so its result is the script's. Otherwise the agent runs it and sends the result back. */
  readonly hosted: boolean;
  /** What `toolCalls()` names it: the tool's type, or an MCP server's tool. */
  readonly name: string;
  readonly arguments: unknown;
  /** The id the agent answers (`call_id`) for a client-run tool; the item's id for a hosted one. */
  readonly id: string;
  /** For a hosted tool: what it gave, as the script says. */
  readonly result?: string;
  readonly items: readonly ToolItem[];
  /** Ids a later request may carry: they attribute it to the same session. */
  readonly ids: readonly string[];
  /** What it produced, for the usage count. */
  readonly text: string;
}

/** What a tool has to build its items: the request, the tool it offered, ids, and where files go. */
export interface ToolContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly request: ModelRequest;
  readonly tool: ModelTool;
  readonly media: MediaStore;
}

/** One built-in tool: which offered tools it answers, what makes a call impossible, and its items. */
export interface BuiltInTool<K extends BuiltInKind> {
  readonly kind: K;
  /** The request's tool types it is offered by, in the order they are looked for. */
  readonly types: readonly string[];
  /** For MCP: which of several offered tools of its type this call is for. */
  pick?(spec: NonNullable<ToolCallInput[K]>, offered: readonly ModelTool[]): ModelTool | undefined;
  /** What makes this call impossible on the real API, in a sentence each (design §5.4). */
  problems?(spec: NonNullable<ToolCallInput[K]>, context: ToolContext): string[];
  /** The call, or one per operation (`apply_patch`), or why the fake can't make it. */
  build(
    spec: NonNullable<ToolCallInput[K]>,
    context: ToolContext,
  ): BuiltInCall | readonly BuiltInCall[] | { readonly problem: string };
}

/** The usual events of a hosted item: `in_progress`, what it does in between, `completed`, each with its item and index. */
export const statusEvents =
  (prefix: string, itemId: string, middle: readonly string[] = []) =>
  (outputIndex: number): ToolEvent[] =>
    ["in_progress", ...middle, "completed"].map((state) => ({
      type: `${prefix}.${state}`,
      data: { output_index: outputIndex, item_id: itemId },
      content: state === "completed",
    }));
