import type { Attribution, Attributor } from "../../core/attribution/index.ts";
import type { Clock, Timers } from "../../core/clock/index.ts";
import { delay } from "../../core/clock/index.ts";
import type { IdGenerator } from "../../core/ids/index.ts";
import type { StreamEnd } from "../../core/stream/index.ts";
import type { Answer } from "./codecs/answer.ts";
import { textChunks, usageOf } from "./codecs/answer.ts";
import { OpenAIError, scriptedError } from "./errors.ts";
import { OPENAI_IDS } from "./ids.ts";
import { answerMedia, type Media, MediaStore } from "./media.ts";
import { type RateLimits, SessionRateLimit } from "./rate-limit.ts";
import { type ModelRequest, requestText } from "./request.ts";
import { type CallContext, fillTemplate, type ScriptRecord, Scripts } from "./scripts.ts";
import { OpenAIStore } from "./store.ts";
import { annotationsOf } from "./tools/citations.ts";
import { buildBuiltIns, builtInKindOf } from "./tools/index.ts";
import type { Turn } from "./turns.ts";

/** Where a call belongs in the channels, from the evidence it was attributed by. */
interface CallPlace {
  readonly channel?: string;
  readonly from?: string;
  readonly conversation?: string;
  readonly thread?: string;
  readonly message?: string;
}

/** One model call, as the fake keeps it while it runs and after. */
export interface CallRecord {
  readonly id: string;
  readonly session: string | undefined;
  readonly endpoint: ModelRequest["endpoint"];
  readonly request: ModelRequest;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly startedAt: number;
  readonly attempt: number;
  readonly attribution: Attribution | undefined;
  readonly place: CallPlace;
  script?: string;
  status: number;
  answer?: Answer;
  error?: string;
  end?: StreamEnd;
  chunksSent?: number;
  durationMs?: number;
  done: boolean;
  /** Its stream stalled, or it is held for a responder or paused: open work, in words. */
  open?: string;
}

/** What the fake answers a call with: an answer, an error, or nothing at all (a scripted timeout). */
export type Outcome =
  | { readonly kind: "answer"; readonly answer: Answer; readonly turn: Turn; readonly script: ScriptRecord }
  | { readonly kind: "error"; readonly error: OpenAIError; readonly afterMs: number }
  | { readonly kind: "timeout" };

/** A call no script answered, or one a script couldn't: a 400 the SDKs don't retry, in channelstack's own code. */
function noScript(message: string): OpenAIError {
  return new OpenAIError(400, {
    message: `channelstack: ${message}`,
    type: "invalid_request_error",
    code: "channelstack_no_script",
  });
}

/** How long a held call waits for its responder before it is refused: the SDKs' default wait. */
const ANSWER_TIMEOUT_MS = 10_000;

export interface OpenAIWorldDeps {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly attribution: Attributor;
  /** The channel context of an attributed call, from its source. */
  place(attribution: Attribution | undefined, request: ModelRequest): CallPlace;
}

/** The fake OpenAI's state: scripts, calls, problems and limits per session, and the stored responses. */
export class OpenAIWorld {
  readonly scripts = new Scripts();
  readonly store = new OpenAIStore();
  readonly media = new MediaStore();
  readonly #deps: OpenAIWorldDeps;
  readonly #calls = new Map<string, CallRecord[]>();
  readonly #problems = new Map<string, string[]>();
  readonly #limits = new Map<string, SessionRateLimit>();
  readonly #unattributed: CallRecord[] = [];

  constructor(deps: OpenAIWorldDeps) {
    this.#deps = deps;
  }

  get ids(): IdGenerator {
    return this.#deps.ids;
  }

  /** A call arrives: attributed, recorded, and in flight until it finishes. */
  begin(request: ModelRequest, body: unknown, headers: Headers): CallRecord {
    const text = requestText(request);
    // A file's name is evidence too: a person's shared file is something only their session was told of.
    const names = request.messages.flatMap((message) =>
      message.role === "user"
        ? message.parts.flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
        : [],
    );
    const attribution = this.#deps.attribution.attribute({
      minted: request.refs,
      tags: request.tags,
      text: [text, ...names].join("\n"),
    });
    const kept: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name !== "authorization" && name !== "api-key") kept[name] = value;
    });
    const record: CallRecord = {
      id: this.#deps.ids.next(
        request.endpoint === "chat.completions" ? OPENAI_IDS.chatCompletion : OPENAI_IDS.response,
      ),
      session: attribution?.session,
      endpoint: request.endpoint,
      request,
      body,
      headers: kept,
      text,
      startedAt: this.#deps.clock(),
      attempt: Number(headers.get("x-stainless-retry-count") ?? 0) || 0,
      attribution,
      place: this.#deps.place(attribution, request),
      status: 200,
      done: false,
    };
    if (record.session === undefined) {
      this.#unattributed.push(record);
      if (this.#unattributed.length > 200) this.#unattributed.shift();
    } else {
      const list = this.#calls.get(record.session) ?? [];
      list.push(record);
      this.#calls.set(record.session, list);
    }
    return record;
  }

  /** A model problem of a session: what makes its waiting matchers fail at once, and its close fail the test. */
  problem(session: string | undefined, message: string): void {
    if (session === undefined) return;
    const list = this.#problems.get(session) ?? [];
    if (!list.includes(message)) list.push(message);
    this.#problems.set(session, list);
  }

  problems(session: string): string[] {
    const scripts = this.scripts.of(session).flatMap((script) => script.problems);
    return [...new Set([...(this.#problems.get(session) ?? []), ...scripts])];
  }

  calls(session: string): readonly CallRecord[] {
    return this.#calls.get(session) ?? [];
  }

  unattributed(): readonly CallRecord[] {
    return this.#unattributed;
  }

  rateLimit(session: string, limits: RateLimits): SessionRateLimit {
    const limiter = new SessionRateLimit(this.#deps.clock, limits);
    this.#limits.set(session, limiter);
    return limiter;
  }

  limiter(session: string | undefined): SessionRateLimit | undefined {
    return session === undefined ? undefined : this.#limits.get(session);
  }

  clearRateLimit(session: string): void {
    this.#limits.delete(session);
  }

  /** What of a session is still open: model calls held, paused or stalled. */
  openWork(session: string): string[] {
    return this.calls(session).flatMap((call) => (!call.done && call.open !== undefined ? [call.open] : []));
  }

  release(session: string): void {
    this.scripts.release(session);
    this.#calls.delete(session);
    this.#problems.delete(session);
    this.#limits.delete(session);
    this.store.release(session);
    this.#deps.attribution.forget(session);
  }

  reset(): void {
    this.store.clear();
    this.media.clear();
    this.#unattributed.length = 0;
  }

  /**
   * What answers this call: the rate limit, then the first script that matches, then its turn
   * (a responder's, from the test). No script is an error, never a made-up answer.
   */
  async outcome(call: CallRecord, abort: AbortSignal): Promise<Outcome> {
    const { session, request } = call;
    if (session === undefined) {
      return { kind: "error", error: noScript(this.#unattributedMessage(call)), afterMs: 0 };
    }
    const limiter = this.limiter(session);
    if (limiter) {
      const waitMs = limiter.admit(Math.ceil(call.text.length / 4));
      if (waitMs !== undefined) {
        const error = scriptedError(limiter.limits.error, {
          model: request.model,
          retryAfterMs: waitMs,
          endpoint: request.endpoint,
        });
        return { kind: "error", error, afterMs: 0 };
      }
    }
    const context: CallContext = {
      ...(call.place.from === undefined ? {} : { from: call.place.from }),
      in: [call.place.conversation, call.place.thread].filter((value): value is string => value !== undefined),
    };
    const script = this.scripts.pick(session, request, call.text, context);
    if (!script) {
      const message = this.#missingMessage(call);
      this.problem(session, message);
      return { kind: "error", error: noScript(message), afterMs: 0 };
    }
    call.script = script.id;
    script.calls.push(call.id);
    let turn: Turn | undefined;
    if (script.turns === undefined) {
      script.used += 1;
      try {
        turn = await this.#ask(script, call, abort);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        script.problems.push(message);
        return { kind: "error", error: noScript(message), afterMs: 0 };
      }
    } else {
      turn = this.scripts.take(script);
    }
    if (turn === undefined) {
      const message = `${script.id} has no turn for call ${script.used}`;
      this.problem(session, message);
      return { kind: "error", error: noScript(message), afterMs: 0 };
    }
    const timing = { ...script.timing, ...turn.timing };
    if (turn.error === "timeout") return { kind: "timeout" };
    if (turn.error !== undefined) {
      const error = scriptedError(turn.error, {
        model: request.model,
        message: turn.message,
        retryAfterMs: turn.retryAfter,
        shouldRetry: turn.shouldRetry,
        endpoint: request.endpoint,
      });
      return { kind: "error", error, afterMs: timing.firstToken ?? 0 };
    }
    const problems = this.scripts.problemsOf(script, turn, request);
    if (problems.length > 0) {
      for (const problem of problems) if (!script.problems.includes(problem)) script.problems.push(problem);
      return { kind: "error", error: noScript(problems.join("; ")), afterMs: 0 };
    }
    const answer = this.#answer(turn, request, call, script);
    if ("problems" in answer) {
      for (const problem of answer.problems) if (!script.problems.includes(problem)) script.problems.push(problem);
      return { kind: "error", error: noScript(answer.problems.join("; ")), afterMs: 0 };
    }
    return { kind: "answer", answer, turn: { ...turn, timing }, script };
  }

  /**
   * A turn's media for this request, or why the real API couldn't answer with it: an image only
   * from the Images API, audio only from speech or a Chat Completion that asked for audio, each
   * in the format the request asks for.
   */
  #media(turn: Turn, request: ModelRequest, id: string): { media?: NonNullable<Answer["media"]>; problems: string[] } {
    const problems: string[] = [];
    const images: Media[] = [];
    let audio: (Media & { id: string }) | undefined;
    const images_ = request.endpoint === "images.generations" || request.endpoint === "images.edits";
    const speaks = request.endpoint === "audio.speech" || request.audioOutput !== undefined;
    if (turn.image !== undefined && !images_)
      problems.push(
        `${id} answered with an image, but only the Images API answers with one (the request is ${request.endpoint})`,
      );
    if (turn.audio !== undefined && !speaks) {
      problems.push(
        `${id} answered with audio, but the request (${request.endpoint}) didn't ask for audio: speech, or Chat Completions with \`modalities: ["text", "audio"]\``,
      );
    }
    if (images_) {
      const given = turn.image ?? [];
      const n = request.media?.n ?? 1;
      if (given.length === 0) problems.push(`${id} answered the Images API without an image`);
      else if (given.length !== 1 && given.length !== n)
        problems.push(`${id} answered ${given.length} images, but the request asked for ${n}`);
      const format = /^dall-e/.test(request.model) ? "png" : (request.media?.outputFormat ?? "png");
      for (const source of given.length === 1 ? Array.from({ length: n }, () => given[0]) : given) {
        if (source === undefined) continue;
        const made = answerMedia(source, format, `${id}'s image`);
        if ("problem" in made) problems.push(made.problem);
        else images.push(made);
      }
    }
    if (speaks) {
      const format =
        request.endpoint === "audio.speech"
          ? (request.media?.responseFormat ?? "mp3")
          : (request.audioOutput?.format ?? "wav");
      if (turn.audio === undefined)
        problems.push(`${id} answered without audio, but the request asked for ${format} audio`);
      else {
        const made = answerMedia(turn.audio, format, `${id}'s audio`);
        if ("problem" in made) problems.push(made.problem);
        else audio = { ...made, id: this.#deps.ids.next(OPENAI_IDS.audio) };
      }
    }
    if (
      request.endpoint !== "chat.completions" &&
      request.endpoint !== "responses" &&
      (turn.toolCalls ?? []).length > 0
    )
      problems.push(`${id} called tools, but the request (${request.endpoint}) offers none`);
    if (images.length === 0 && audio === undefined) return { problems };
    return { media: { images, ...(audio === undefined ? {} : { audio }) }, problems };
  }

  /** A responder's turn: the call is held, the test's SDK reads it and answers. */
  #ask(script: ScriptRecord, call: CallRecord, abort: AbortSignal): Promise<Turn> {
    const id = this.#deps.ids.next(OPENAI_IDS.held);
    call.open = `a model call held for the responder ${script.id}`;
    return new Promise<Turn>((resolve, reject) => {
      const done = () => {
        script.held.delete(id);
        cancel();
        delete call.open;
      };
      const cancel = this.#deps.timers.after(ANSWER_TIMEOUT_MS, () => {
        done();
        reject(
          new Error(`the test didn't answer the model call held for ${script.id} within ${ANSWER_TIMEOUT_MS / 1000}s`),
        );
      });
      abort.addEventListener("abort", () => {
        done();
        reject(new Error(`the agent hung up while the call was held for ${script.id}`));
      });
      script.held.set(id, {
        id,
        script: script.id,
        request: call.request,
        answer: (turn) => {
          done();
          resolve(turn);
        },
        fail: (reason) => {
          done();
          reject(new Error(`the responder for ${script.id} threw: ${reason}`));
        },
      });
      script.requests.append({ id, request: call });
      for (const wake of [...script.waiting]) wake();
    });
  }

  /** A turn as an answer: its templates filled, its ids minted, its usage counted; or why the real API couldn't send it. */
  #answer(turn: Turn, request: ModelRequest, call: CallRecord, script: ScriptRecord): Answer | { problems: string[] } {
    const number = script.used;
    const fill = (text: string) => fillTemplate(text, request, number);
    const chunks = Array.isArray(turn.text) ? turn.text.map(fill) : textChunks(fill(turn.text ?? ""));
    const text = chunks.join("");
    const { ids, clock } = this.#deps;
    const specs = turn.toolCalls ?? [];
    const built = buildBuiltIns(specs, { ids, clock, request, media: this.media }, script.id);
    const media = this.#media(turn, request, script.id);
    const cited = annotationsOf(text, turn.citations ?? [], {
      endpoint: request.endpoint === "chat.completions" ? "chat.completions" : "responses",
      ids,
      media: this.media,
      written: built.calls.flatMap((tool) => tool.files ?? []),
      script: script.id,
    });
    const problems = [...built.problems, ...media.problems, ...cited.problems];
    if (problems.length > 0) return { problems };
    for (const file of built.calls.flatMap((tool) => tool.files ?? [])) this.media.keepContainerFile(file);
    const toolCalls = specs
      .filter((spec) => builtInKindOf(spec) === undefined)
      .map((spec) => {
        const custom = spec.input !== undefined;
        const args = custom
          ? (spec.input as string)
          : typeof spec.arguments === "string"
            ? spec.arguments
            : JSON.stringify(spec.arguments ?? {});
        return {
          id: ids.next(OPENAI_IDS.call),
          itemId: ids.next(custom ? OPENAI_IDS.customCall : OPENAI_IDS.functionCall),
          name: spec.name ?? "",
          kind: custom ? ("custom" as const) : ("function" as const),
          arguments: custom ? args : fill(args),
        };
      });
    const summary = turn.reasoning?.summary;
    const reasoningTokens = turn.reasoning ? (turn.reasoning.tokens ?? 64) : 0;
    const finish =
      turn.finish ??
      (request.maxOutputTokens !== undefined && Math.ceil(text.length / 4) > request.maxOutputTokens
        ? "length"
        : toolCalls.length > 0 || built.calls.some((tool) => !tool.hosted)
          ? "tool_calls"
          : "stop");
    const base = {
      text:
        finish === "length" && request.maxOutputTokens !== undefined
          ? text.slice(0, request.maxOutputTokens * 4)
          : text,
      toolCalls,
      builtIns: built.calls,
      ...(turn.refusal === undefined ? {} : { refusal: fill(turn.refusal) }),
    };
    const answer: Answer = {
      ...base,
      chunks: base.text === text ? chunks : textChunks(base.text),
      ...(turn.reasoning
        ? {
            reasoning: {
              itemId: ids.next(OPENAI_IDS.reasoning),
              summary: summary === undefined ? [] : Array.isArray(summary) ? summary.map(fill) : [fill(summary)],
              tokens: reasoningTokens,
            },
          }
        : {}),
      finish,
      annotations: cited.annotations,
      ...(media.media === undefined ? {} : { media: media.media }),
      usage: usageOf(call.text, base, reasoningTokens, turn.usage),
      messageId: ids.next(OPENAI_IDS.message),
    };
    // A later request that carries one of these ids belongs to the same session.
    if (call.session !== undefined) {
      this.#deps.attribution.mint(call.session, [
        call.id,
        answer.messageId,
        ...answer.toolCalls.flatMap((tool) => [tool.id, tool.itemId]),
        ...answer.builtIns.flatMap((tool) => tool.ids),
        ...(answer.reasoning ? [answer.reasoning.itemId] : []),
      ]);
    }
    return answer;
  }

  /** The call ended: how, and with what. */
  finish(call: CallRecord, result: { status: number; error?: string; end?: StreamEnd; chunksSent?: number }): void {
    call.status = result.status;
    if (result.error !== undefined) call.error = result.error;
    if (result.end !== undefined) call.end = result.end;
    if (result.chunksSent !== undefined) call.chunksSent = result.chunksSent;
    call.durationMs = this.#deps.clock() - call.startedAt;
    call.done = true;
    delete call.open;
  }

  #missingMessage(call: CallRecord): string {
    const { request } = call;
    const tools = request.tools.map((tool) => tool.name ?? tool.type);
    const user = request.lastUserText ?? "";
    const quoted = user.length > 80 ? `${user.slice(0, 77)}…` : user;
    const example =
      quoted === "" ? `openai.respond("…")` : `openai.respond("…", { when: { text: ${JSON.stringify(quoted)} } })`;
    return `no openai.respond(…) in this test answers this call. Newest user message: ${JSON.stringify(quoted)}. Tools offered: ${tools.length === 0 ? "none" : tools.join(", ")}. For example: ${example}`;
  }

  #unattributedMessage(call: CallRecord): string {
    return `this call couldn't be attributed to any test: nothing in it matches what a test's people wrote, an id a test owns, or an earlier answer. ${this.#missingMessage(call).replace(/^no openai\.respond\(…\) in this test answers this call\. /, "")}`;
  }

  /** Wait the time a turn asks before its answer starts. */
  wait(ms: number): Promise<void> {
    return delay(this.#deps.timers, ms);
  }
}
