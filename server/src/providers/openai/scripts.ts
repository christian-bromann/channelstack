import { Ajv } from "ajv";

import { CursorList } from "../../core/events/index.ts";
import { matchesText } from "../../core/router/inspect.ts";
import type { ModelRequest } from "./request.ts";
import { builtInKindOf } from "./tools/index.ts";
import type { Match, Turn, TurnInput } from "./turns.ts";
import { turnOf } from "./turns.ts";

/** A call the server holds for a responder until the test answers it. */
interface HeldCall {
  readonly id: string;
  readonly script: string;
  /** The request as the responder sees it. */
  readonly request: unknown;
  answer(turn: Turn): void;
  fail(reason: string): void;
}

/** One `openai.respond(…)` of a test. */
export interface ScriptRecord {
  readonly id: string;
  readonly session: string;
  /** A turn list, used in order; or none for a responder. */
  readonly turns: readonly Turn[] | undefined;
  readonly when: Match | undefined;
  /** How many calls it answers. */
  readonly times: number;
  readonly timing: Turn["timing"];
  used: number;
  readonly calls: string[];
  readonly problems: string[];
  /** For a responder: the calls it holds, as the test's SDK reads them, and those still waiting. */
  readonly requests: CursorList<{ id: string; request: unknown }>;
  readonly held: Map<string, HeldCall>;
  /** Streams it holds at `pauseAfter`, by call. */
  readonly paused: Map<string, () => void>;
  /** Long polls waiting for a call to be held. */
  readonly waiting: Set<() => void>;
}

/** Where a call came from in the channels, from attribution. */
export interface CallContext {
  readonly from?: string;
  readonly in?: readonly string[];
}

/** Text and tools of a request, as the matchers read them. */
function matches(when: Match | undefined, request: ModelRequest, text: string, context: CallContext): boolean {
  if (when === undefined) return true;
  if (when.text !== undefined && !matchesText(when.text, { ignoreCase: true })(request.lastUserText ?? ""))
    return false;
  if (when.prompt !== undefined && !matchesText(when.prompt, { ignoreCase: true })(text)) return false;
  if (when.tools !== undefined) {
    const offered = new Set(request.tools.map((tool) => tool.name ?? tool.type));
    if (!when.tools.every((tool) => offered.has(tool))) return false;
  }
  if (when.toolResult !== undefined) {
    const results = request.lastToolResults;
    if (when.toolResult === false ? results.length > 0 : results.length === 0) return false;
    if (typeof when.toolResult === "string" && !results.some((result) => result.name === when.toolResult)) return false;
  }
  if (when.endpoint !== undefined && when.endpoint !== request.endpoint) return false;
  if (when.model !== undefined && !matchesText(when.model)(request.model)) return false;
  if (when.stream !== undefined && when.stream !== request.stream) return false;
  if (when.from !== undefined && context.from !== when.from) return false;
  if (when.approval !== undefined) {
    const newest = request.approvals.at(-1);
    if (newest === undefined || newest.approve !== when.approval) return false;
  }
  if (when.in !== undefined && !(context.in ?? []).includes(when.in)) return false;
  return true;
}

/** What a template in a turn's text names, from the request. */
export function fillTemplate(text: string, request: ModelRequest, call: number): string {
  return text.replace(/\{(lastUserText|toolResult(?:\.[\w-]+)?|model|call)\}/g, (_, name: string) => {
    if (name === "lastUserText") return request.lastUserText ?? "";
    if (name === "model") return request.model;
    if (name === "call") return String(call);
    if (name === "toolResult") return request.lastToolResults.at(-1)?.text ?? "";
    const tool = name.slice("toolResult.".length);
    return request.lastToolResults.find((result) => result.name === tool)?.text ?? "";
  });
}

/** A test's scripts, per session, and which one answers a call. */
export class Scripts {
  readonly #bySession = new Map<string, ScriptRecord[]>();
  readonly #byId = new Map<string, ScriptRecord>();
  readonly #ajv = new Ajv({ strict: false, allErrors: false });

  add(
    record: Omit<ScriptRecord, "used" | "calls" | "problems" | "requests" | "held" | "paused" | "waiting">,
  ): ScriptRecord {
    const script: ScriptRecord = {
      ...record,
      used: 0,
      calls: [],
      problems: [],
      requests: new CursorList(),
      held: new Map(),
      paused: new Map(),
      waiting: new Set(),
    };
    const list = this.#bySession.get(record.session) ?? [];
    list.push(script);
    this.#bySession.set(record.session, list);
    this.#byId.set(script.id, script);
    return script;
  }

  get(session: string, id: string): ScriptRecord | undefined {
    const script = this.#byId.get(id);
    return script?.session === session ? script : undefined;
  }

  of(session: string): readonly ScriptRecord[] {
    return this.#bySession.get(session) ?? [];
  }

  remove(session: string, id: string): void {
    const script = this.get(session, id);
    if (!script) return;
    for (const held of script.held.values()) held.fail("the script was undone");
    for (const resume of script.paused.values()) resume();
    for (const wake of script.waiting) wake();
    this.#byId.delete(id);
    this.#bySession.set(
      session,
      this.of(session).filter((other) => other.id !== id),
    );
  }

  release(session: string): void {
    for (const script of this.of(session)) this.remove(session, script.id);
    this.#bySession.delete(session);
  }

  /**
   * The script that answers this call: the first, in the order they were added, whose `when`
   * holds and that has calls left. A list that ran out no longer answers; that is noted on it.
   */
  pick(session: string, request: ModelRequest, text: string, context: CallContext): ScriptRecord | undefined {
    for (const script of this.of(session)) {
      if (!matches(script.when, request, text, context)) continue;
      if (script.used >= script.times) {
        const note = `${script.id} has ${script.times} ${script.times === 1 ? "turn" : "turns"}; call ${script.used + 1} arrived`;
        if (!script.problems.includes(note)) script.problems.push(note);
        continue;
      }
      return script;
    }
    return undefined;
  }

  /** The next turn of a list, its use counted. A list asked to answer more calls than it has turns goes round again. */
  take(script: ScriptRecord): Turn | undefined {
    const { turns } = script;
    const turn = turns === undefined || turns.length === 0 ? undefined : turns[script.used % turns.length];
    script.used += 1;
    return turn;
  }

  /** What makes a turn impossible on the real API for this request, in a sentence each. */
  problemsOf(script: ScriptRecord, turn: Turn, request: ModelRequest): string[] {
    const problems: string[] = [];
    const offered = new Map(
      request.tools.filter((tool) => tool.name !== undefined).map((tool) => [tool.name as string, tool]),
    );
    // Built-in tools are checked as they are built (`tools/`).
    for (const call of (turn.toolCalls ?? []).filter((spec) => builtInKindOf(spec) === undefined)) {
      if (call.name === undefined) continue;
      const tool = offered.get(call.name);
      if (!tool) {
        const names = [...offered.keys()];
        problems.push(
          `${script.id} called \`${call.name}\`, but the request offered ${names.length === 0 ? "no tools" : names.map((name) => `\`${name}\``).join(", ")}`,
        );
        continue;
      }
      if (request.toolChoice === "none")
        problems.push(`${script.id} called \`${call.name}\`, but the request's tool_choice is "none"`);
      if (tool.strict === true && tool.parameters !== undefined && typeof call.arguments === "object") {
        const valid = this.#ajv.validate(tool.parameters as object, call.arguments);
        if (!valid) {
          problems.push(
            `${script.id} called \`${call.name}\` with arguments its strict schema refuses: ${this.#ajv.errorsText(this.#ajv.errors)}`,
          );
        }
      }
    }
    const format = request.responseFormat;
    const body = typeof turn.text === "string" ? turn.text : (turn.text ?? []).join("");
    if (format !== undefined && format.type !== "text" && body !== "" && (turn.toolCalls ?? []).length === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        problems.push(`${script.id} answered text that isn't JSON, but the request asked for ${format.type}`);
      }
      if (parsed !== undefined && format.type === "json_schema" && format.strict === true) {
        if (!this.#ajv.validate(format.schema as object, parsed)) {
          problems.push(
            `${script.id} answered JSON that the strict schema "${format.name}" refuses: ${this.#ajv.errorsText(this.#ajv.errors)}`,
          );
        }
      }
    }
    return problems;
  }
}

/** A turn list as the routes take it: one turn, or several. */
export const turnsOf = (input: TurnInput | readonly TurnInput[]): Turn[] =>
  (Array.isArray(input) ? input : [input]).map((turn: TurnInput) => turnOf(turn));
