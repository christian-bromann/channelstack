import { z } from "@hono/zod-openapi";

import { iso, type Timers } from "../../core/clock/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { IdGenerator } from "../../core/ids/index.ts";
import { type DriverRouter, pathParam } from "../../core/router/index.ts";
import { duration } from "../../core/router/inspect.ts";
import { OPENAI_IDS } from "./ids.ts";
import type { ModelPart } from "./media.ts";
import type { ModelRequest } from "./request.ts";
import { turnsOf } from "./scripts.ts";
import { ENDPOINTS, MatchSchema, TurnObject, TurnSchema } from "./turns.ts";
import type { CallRecord, OpenAIWorld } from "./world.ts";

/** The fake's calls aren't live: a model call is the agent's, and live mode never fakes what the agent calls. */
const stability = "experimental";

const Ref = z.object({ id: z.string() }).openapi("OpenAIRef");

const Context = z
  .object({
    channel: z.string().optional().openapi({ description: "The channel the call answers a message from (`slack`)." }),
    from: Ref.optional().openapi({ description: "The person whose message the call answers." }),
    conversation: Ref.optional(),
    thread: Ref.optional(),
    message: Ref.optional(),
    attributedBy: z.enum(["minted_id", "tag", "owned_id", "text", "order"]).optional(),
  })
  .openapi("OpenAIContext");

/** An image, file or audio part the agent sent, identified by its hash (design §5.5). */
const Part = z
  .object({
    type: z.enum(["image", "file", "audio"]),
    from: z.enum(["data", "file_id", "url"]),
    url: z.string().optional(),
    fileId: z.string().optional().openapi({ description: "For `file_id`: the file in `/v1/files`." }),
    mediaType: z.string().optional().openapi({ description: "None for a URL the fake didn't fetch." }),
    bytes: z.number().int().optional(),
    sha256: z.string().optional().openapi({ description: "What `toHaveSentFile` compares." }),
    filename: z.string().optional(),
  })
  .openapi("OpenAIPart");

const Message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    text: z.string(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.unknown() })).optional(),
    callId: z.string().optional().openapi({ description: "A tool result: the call it answers." }),
    name: z.string().optional().openapi({ description: "A tool result: the tool's name." }),
    parts: z.array(Part).optional(),
  })
  .openapi("OpenAIMessage");

const Endpoint = z.enum(ENDPOINTS).openapi("OpenAIEndpoint");

const Request = z
  .object({
    endpoint: Endpoint,
    model: z.string(),
    stream: z.boolean(),
    prompt: z.string().optional().openapi({ description: "The Images API's prompt, or the text speech is made from." }),
    file: Part.optional().openapi({ description: "The audio to transcribe, or the image to edit." }),
    instructions: z.string().optional(),
    messages: z.array(Message),
    tools: z.array(
      z
        .object({
          type: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          parameters: z.unknown().optional(),
          strict: z.boolean().optional(),
          settings: z
            .record(z.string(), z.unknown())
            .optional()
            .openapi({ description: "A built-in tool's settings, as the request gave them." }),
        })
        .openapi("OpenAITool"),
    ),
    toolChoice: z.unknown().optional(),
    responseFormat: z.unknown().optional(),
    lastUserText: z.string().optional(),
    lastToolResults: z.array(z.object({ callId: z.string(), name: z.string().optional(), text: z.string() })),
    text: z.string().openapi({ description: "Everything the request says, as one text: what `toHaveSent` reads." }),
    context: Context,
    body: z.unknown().openapi({ description: "The body exactly as the agent sent it." }),
    headers: z.record(z.string(), z.string()).openapi({ description: "Its headers, without the key." }),
  })
  .openapi("OpenAIRequest");

const ToolCall = z
  .object({
    id: z.string(),
    type: z.enum([
      "function",
      "custom",
      "web_search",
      "file_search",
      "code_interpreter",
      "image_generation",
      "mcp",
      "shell",
      "computer",
      "apply_patch",
    ]),
    hosted: z.boolean().openapi({ description: "OpenAI ran it, so `result` is what the script said." }),
    name: z.string(),
    arguments: z.unknown(),
    madeIn: z.string().openapi({ description: "The call whose answer made it." }),
    result: z
      .object({ text: z.string(), sentIn: z.string() })
      .optional()
      .openapi({ description: "What the agent sent back, and in which call. None: the agent never answered it." }),
  })
  .openapi("OpenAIToolCall");

const Call = z
  .object({
    id: z.string().openapi({ description: "The response's own id: `chatcmpl-…` or `resp_…`." }),
    endpoint: Endpoint,
    model: z.string(),
    stream: z.boolean(),
    at: z.string(),
    durationMs: z.number(),
    attempt: z.number().int().openapi({ description: "0 for a first try; the SDK's retry number when it sends one." }),
    done: z.boolean(),
    request: Request,
    response: z.object({
      status: z.number().int(),
      text: z.string().optional(),
      finish: z.string().optional(),
      error: z.string().optional(),
      aborted: z.boolean().openapi({ description: "The agent hung up before the answer was complete." }),
      chunksSent: z.number().int().optional(),
      end: z.enum(["completed", "errored", "dropped", "stalled", "aborted"]).optional(),
    }),
    toolCalls: z.array(ToolCall),
    script: z
      .string()
      .optional()
      .openapi({ description: "The script that answered. None: the call was refused for want of one." }),
  })
  .openapi("OpenAICall", { "x-channelstack-resource": { id: "id" } });

const Script = z
  .object({
    id: z.string(),
    responder: z.boolean(),
    times: z.number().openapi({ description: "How many calls it answers (`-1`: unlimited)." }),
    used: z.number().int(),
    problems: z.array(z.string()),
  })
  .openapi("OpenAIScript", { "x-channelstack-resource": { id: "id" } });

const Fixture = z
  .object({ baseUrl: z.string().openapi({ description: "What the agent's OPENAI_BASE_URL should be." }) })
  .openapi("OpenAIFixture", { "x-channelstack-resource": {} });

const RateLimit = z
  .object({
    id: z.string(),
    requests: z.number().int().optional(),
    tokens: z.number().int().optional(),
    resetsInMs: z.number(),
  })
  .openapi("OpenAIRateLimit", { "x-channelstack-resource": { id: "id" } });

const Unattributed = z
  .object({
    id: z.string(),
    endpoint: Endpoint,
    model: z.string(),
    at: z.string(),
    lastUserText: z.string().optional(),
    tools: z.array(z.string()),
  })
  .openapi("OpenAIUnattributedCall");

const Held = z.object({ id: z.string(), request: Request }).openapi("OpenAIHeldCall");

const ScriptParams = z.object({ script: pathParam("script") });

/** How the routes scrub what they return: a secret the agent leaked into a prompt never leaves the server. */
type Scrub = <T>(value: T) => T;

/** A call's request, as a test reads it, with every token and secret channelstack knows scrubbed. */
function requestWire(call: CallRecord, scrub: Scrub) {
  return scrub(rawRequestWire(call));
}

/** A part as a test reads it: what it is and its hash, never its bytes. */
const partWire = ({ pending: _pending, ...part }: ModelPart) => part;

function rawRequestWire(call: CallRecord) {
  const request: ModelRequest = call.request;
  return {
    endpoint: request.endpoint,
    model: request.model,
    stream: request.stream,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.file === undefined ? {} : { file: partWire(request.file) }),
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    messages: request.messages.map((message) => ({
      role: message.role,
      text: message.text,
      ...(message.role === "assistant" ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
      ...(message.role === "tool"
        ? { callId: message.callId, ...(message.name === undefined ? {} : { name: message.name }) }
        : {}),
      ...(message.role === "user" ? { parts: message.parts.map(partWire) } : {}),
    })),
    tools: request.tools.map((tool) => ({ ...tool })),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.lastUserText === undefined ? {} : { lastUserText: request.lastUserText }),
    lastToolResults: request.lastToolResults.map((result) => ({ ...result })),
    text: call.text,
    context: {
      ...(call.place.channel === undefined ? {} : { channel: call.place.channel }),
      ...(call.place.from === undefined ? {} : { from: { id: call.place.from } }),
      ...(call.place.conversation === undefined ? {} : { conversation: { id: call.place.conversation } }),
      ...(call.place.thread === undefined ? {} : { thread: { id: call.place.thread } }),
      ...(call.place.message === undefined ? {} : { message: { id: call.place.message } }),
      ...(call.attribution === undefined ? {} : { attributedBy: call.attribution.by }),
    },
    body: call.body,
    headers: call.headers,
  };
}

/** The tool calls of a session's calls, each joined with the result the agent sent in a later call. */
function toolCallsOf(calls: readonly CallRecord[], made: readonly CallRecord[] = calls) {
  const results = new Map<string, { text: string; sentIn: string }>();
  for (const call of calls) {
    for (const message of call.request.messages) {
      if (message.role === "tool" && !results.has(message.callId))
        results.set(message.callId, { text: message.text, sentIn: call.id });
    }
  }
  return made.flatMap((call) => [
    ...(call.answer?.toolCalls ?? []).map((tool) => {
      const result = results.get(tool.id);
      let args: unknown = tool.arguments;
      if (tool.kind === "function") {
        try {
          args = JSON.parse(tool.arguments);
        } catch {
          args = tool.arguments;
        }
      }
      return {
        id: tool.id,
        type: tool.kind,
        hosted: false,
        name: tool.name,
        arguments: args,
        madeIn: call.id,
        ...(result === undefined ? {} : { result }),
      };
    }),
    // OpenAI's built-in tools: a hosted one's result is the script's, in the same call; a client-run one's is the agent's.
    ...(call.answer?.builtIns ?? []).map((tool) => {
      const result =
        tool.hosted && tool.result !== undefined ? { text: tool.result, sentIn: call.id } : results.get(tool.id);
      return {
        id: tool.id,
        type: tool.type,
        hosted: tool.hosted,
        name: tool.name,
        arguments: tool.arguments,
        madeIn: call.id,
        ...(result === undefined ? {} : { result }),
      };
    }),
  ]);
}

function callWire(call: CallRecord, all: readonly CallRecord[], scrub: Scrub) {
  return {
    id: call.id,
    endpoint: call.endpoint,
    model: call.request.model,
    stream: call.request.stream,
    at: iso(call.startedAt),
    durationMs: call.durationMs ?? 0,
    attempt: call.attempt,
    done: call.done,
    request: requestWire(call, scrub),
    response: {
      status: call.status,
      ...(call.answer === undefined ? {} : { text: call.answer.text, finish: call.answer.finish }),
      ...(call.error === undefined ? {} : { error: call.error }),
      aborted: call.end === "aborted" || call.end === "stalled",
      ...(call.chunksSent === undefined ? {} : { chunksSent: call.chunksSent }),
      ...(call.end === undefined ? {} : { end: call.end }),
    },
    toolCalls: toolCallsOf(all, [call]),
    ...(call.script === undefined ? {} : { script: call.script }),
  };
}

/** How long a responder's long poll waits for a held call before it answers with none. */
const LONG_POLL_MS = 25_000;

/** The fake OpenAI's control API: what a test scripts, and what it reads back. */
export function registerOpenAIRoutes(
  router: DriverRouter,
  deps: {
    world: OpenAIWorld;
    ids: IdGenerator;
    timers: Timers;
    baseUrl: () => string;
    scrub<T>(value: T): T;
    findSecrets(text: string): string[];
  },
): void {
  const { world } = deps;
  const { scrub } = deps;
  const scriptWire = (script: NonNullable<ReturnType<OpenAIWorld["scripts"]["get"]>>) => ({
    id: script.id,
    responder: script.turns === undefined,
    times: Number.isFinite(script.times) ? script.times : -1,
    used: script.used,
    problems: [...script.problems],
  });
  const scriptOf = (session: string, id: string) => {
    const script = world.scripts.get(session, id);
    if (!script) throw new ProtocolError("not_found", `No OpenAI script "${id}" in this session`, { id });
    return script;
  };

  router.route({
    method: "get",
    path: "",
    summary: "The OpenAI fixture: where the agent reaches the fake model",
    response: Fixture,
    factory: { on: "Session", name: "openai" },
    stability,
    handler: () => ({ baseUrl: deps.baseUrl() }),
  });

  router.route({
    method: "post",
    path: "/scripts",
    summary:
      "Script what the model answers: turns used in order, one per matching call, or a responder the test answers. Scripts are tried in the order they were added",
    body: z
      .object({
        turns: z
          .array(TurnSchema)
          .optional()
          .openapi({ "x-channelstack-one-or-many": true, description: "The turns, in order: one per matching call." }),
        responder: z
          .boolean()
          .default(false)
          .openapi({ description: "The test answers each call itself (a function)." }),
        when: MatchSchema.optional(),
        times: z.number().int().optional().openapi({
          description: "How many calls it answers. Default: the number of turns; unlimited for a responder (`-1`).",
        }),
        timing: TurnObject.shape.timing,
      })
      .openapi("OpenAIRespondBody"),
    response: Script,
    errors: ["not_found"],
    factory: {
      on: "OpenAIFixture",
      name: "respond",
      args: ["turns"],
      options: ["when", "times", "timing", "responder"],
      responder: { flag: "responder", held: "heldCalls", answer: "answerHeld", request: "OpenAIRequest" },
    },
    stability,
    handler: ({ session, body }) => {
      const turns = body.turns === undefined ? undefined : turnsOf(body.turns);
      if (!body.responder && (turns === undefined || turns.length === 0)) {
        throw new ProtocolError("invalid_argument", "respond needs at least one turn, or a responder");
      }
      // Default: a list answers as many calls as it has turns; a responder, every call. `-1` is unlimited.
      const times =
        body.times === undefined
          ? body.responder
            ? Number.POSITIVE_INFINITY
            : (turns?.length ?? 0)
          : body.times < 0
            ? Number.POSITIVE_INFINITY
            : body.times;
      const script = world.scripts.add({
        id: deps.ids.next(OPENAI_IDS.script),
        session: session.id,
        turns: body.responder ? undefined : turns,
        when: body.when,
        times,
        timing: body.timing,
      });
      return scriptWire(script);
    },
  });

  router.route({
    method: "get",
    path: "/scripts/{script}",
    summary: "Re-read a script: how many calls it answered, and its problems",
    params: ScriptParams,
    response: Script,
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "refresh" },
    stability,
    handler: ({ session, params }) => scriptWire(scriptOf(session.id, params.script)),
  });

  router.route({
    method: "delete",
    path: "/scripts/{script}",
    summary: "Remove a script. Closing the session does it too",
    params: ScriptParams,
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "undo", dispose: true },
    stability,
    handler: ({ session, params }) => {
      world.scripts.remove(session.id, params.script);
    },
  });

  router.route({
    method: "post",
    path: "/scripts/{script}/resume",
    summary: "Let the streams this script holds at `pauseAfter` go on",
    params: ScriptParams,
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "resume" },
    stability,
    handler: ({ session, params }) => {
      const script = scriptOf(session.id, params.script);
      for (const resume of script.paused.values()) resume();
      script.paused.clear();
    },
  });

  router.route({
    method: "get",
    path: "/scripts/{script}/calls",
    summary: "The calls this script answered",
    params: ScriptParams,
    response: z.array(Call).openapi("OpenAICalls"),
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "calls" },
    waits: [{ name: "waitForCall", mode: "next", what: "a model call this script answers" }],
    stability,
    handler: ({ session, params }) => {
      const script = scriptOf(session.id, params.script);
      const all = world.calls(session.id);
      return all.filter((call) => call.script === script.id).map((call) => callWire(call, all, scrub));
    },
  });

  router.route({
    method: "get",
    path: "/scripts/{script}/paused",
    summary: "The calls whose streams this script holds at `pauseAfter`",
    params: ScriptParams,
    response: z.array(Call).openapi("OpenAIPausedCalls"),
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "pausedCalls" },
    waits: [{ name: "waitForPause", mode: "next", what: "a stream held at pauseAfter" }],
    stability,
    handler: ({ session, params }) => {
      const script = scriptOf(session.id, params.script);
      const all = world.calls(session.id);
      return all.filter((call) => script.paused.has(call.id)).map((call) => callWire(call, all, scrub));
    },
  });

  router.route({
    method: "get",
    path: "/scripts/{script}/tool-calls",
    summary: "The tool calls this script made, each with the result the agent sent back",
    params: ScriptParams,
    query: z.object({
      name: z
        .string()
        .optional()
        .openapi({ param: { name: "name", in: "query" } }),
    }),
    response: z.array(ToolCall).openapi("OpenAIToolCalls"),
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "toolCalls", options: ["name"] },
    stability,
    handler: ({ session, params, query }) => {
      const script = scriptOf(session.id, params.script);
      const all = world.calls(session.id);
      return toolCallsOf(
        all,
        all.filter((call) => call.script === script.id),
      ).filter((tool) => query.name === undefined || tool.name === query.name);
    },
  });

  router.route({
    method: "get",
    path: "/scripts/{script}/requests",
    summary: "For a responder's SDK: the calls held for it since `since`, waiting up to `waitMs` for one",
    params: ScriptParams,
    query: z.object({
      since: z
        .string()
        .optional()
        .openapi({ param: { name: "since", in: "query" } }),
      waitMs: z.coerce
        .number()
        .int()
        .min(0)
        .max(LONG_POLL_MS)
        .optional()
        .openapi({ param: { name: "waitMs", in: "query" } }),
    }),
    response: z.object({ held: z.array(Held), cursor: z.string() }).openapi("OpenAIHeldPage"),
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "heldCalls", options: ["since", "waitMs"] },
    stability,
    handler: async ({ session, params, query }) => {
      const script = scriptOf(session.id, params.script);
      const read = () => {
        const { items, cursor } = script.requests.read(query.since);
        return { held: items.filter((item) => script.held.has(item.id)), cursor };
      };
      let page = read();
      if (page.held.length === 0 && (query.waitMs ?? 0) > 0) {
        // Wait for a call to be held, the script to go, or the time to run out: whichever comes first.
        await new Promise<void>((resolve) => {
          const cancel = deps.timers.after(query.waitMs ?? 0, finish);
          function finish() {
            cancel();
            script.waiting.delete(finish);
            resolve();
          }
          script.waiting.add(finish);
        });
        page = read();
      }
      return {
        held: page.held.map((item) => ({ id: item.id, request: requestWire(item.request as CallRecord, scrub) })),
        cursor: page.cursor,
      };
    },
  });

  router.route({
    method: "post",
    path: "/scripts/{script}/answers",
    summary: "For a responder's SDK: answer a held call with a turn, or report that the test's function threw",
    params: ScriptParams,
    body: z
      .object({ held: z.string(), turn: TurnSchema.optional(), error: z.string().optional() })
      .openapi("OpenAIAnswerBody"),
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIScript", name: "answerHeld", args: ["held"], options: ["turn", "error"] },
    stability,
    handler: ({ session, params, body }) => {
      const script = scriptOf(session.id, params.script);
      const held = script.held.get(body.held);
      if (!held)
        throw new ProtocolError(
          "not_found",
          `No held call "${body.held}" for ${script.id}: it was answered, or the agent hung up`,
        );
      if (body.error !== undefined) held.fail(body.error);
      else if (body.turn !== undefined) held.answer(turnsOf(body.turn)[0] as Parameters<typeof held.answer>[0]);
      else throw new ProtocolError("invalid_argument", "answer needs a turn or an error");
    },
  });

  router.route({
    method: "get",
    path: "/calls",
    summary: "Every model call attributed to this session, oldest first",
    query: z.object({
      endpoint: Endpoint.optional().openapi({ param: { name: "endpoint", in: "query" } }),
      error: z
        .union([z.literal(true), z.string()])
        .optional()
        .openapi({ param: { name: "error", in: "query" }, description: "`true` for any error, or one error code" }),
    }),
    response: z.array(Call).openapi("OpenAISessionCalls"),
    sdkMethod: { on: "OpenAIFixture", name: "calls", options: ["endpoint", "error"] },
    waits: [
      { name: "waitForCall", mode: "next", filter: true, what: "a model call from the agent" },
      { name: "latestCall", mode: "latest", filter: true, what: "a model call from the agent" },
    ],
    stability,
    handler: ({ session, query }) => {
      const all = world.calls(session.id);
      return all
        .filter((call) => call.done || call.open !== undefined)
        .filter((call) => query.endpoint === undefined || call.endpoint === query.endpoint)
        .filter((call) =>
          query.error === undefined
            ? true
            : String(query.error) === "true"
              ? call.error !== undefined
              : call.error === query.error,
        )
        .map((call) => callWire(call, all, scrub));
    },
  });

  router.route({
    method: "get",
    path: "/calls/{call}",
    summary: "Re-read a model call: whether it is done, how it ended",
    params: z.object({ call: pathParam("call") }),
    response: Call,
    errors: ["not_found"],
    sdkMethod: { on: "OpenAICall", name: "refresh" },
    stability,
    handler: ({ session, params }) => {
      const all = world.calls(session.id);
      const call = all.find((candidate) => candidate.id === params.call);
      if (!call)
        throw new ProtocolError("not_found", `No model call "${params.call}" in this session`, { id: params.call });
      return callWire(call, all, scrub);
    },
  });

  router.route({
    method: "get",
    path: "/tool-calls",
    summary: "Every tool call the model made in this session, each with the result the agent sent back",
    query: z.object({
      name: z
        .string()
        .optional()
        .openapi({ param: { name: "name", in: "query" } }),
    }),
    response: z.array(ToolCall).openapi("OpenAISessionToolCalls"),
    sdkMethod: { on: "OpenAIFixture", name: "toolCalls", options: ["name"] },
    stability,
    handler: ({ session, query }) =>
      toolCallsOf(world.calls(session.id)).filter((tool) => query.name === undefined || tool.name === query.name),
  });

  router.route({
    method: "get",
    path: "/problems",
    summary:
      "What went wrong with the model in this session: a call no script answered, a script that ran out or did what the real API can't, a responder that threw. Matchers fail at once on these",
    response: z.array(z.string()).openapi("OpenAIProblems"),
    sdkMethod: { on: "OpenAIFixture", name: "problems" },
    stability,
    handler: ({ session }) => world.problems(session.id),
  });

  router.route({
    method: "get",
    path: "/sent-secrets",
    summary:
      "The calls that sent a secret channelstack knows to the model, and the kinds they sent (`slack.botToken`): never the values",
    response: z
      .array(z.object({ call: z.string(), kinds: z.array(z.string()) }).openapi("OpenAISentSecret"))
      .openapi("OpenAISentSecrets"),
    sdkMethod: { on: "OpenAIFixture", name: "sentSecrets" },
    stability,
    handler: ({ session }) =>
      world.calls(session.id).flatMap((call) => {
        const kinds = deps.findSecrets(JSON.stringify(call.body ?? ""));
        return kinds.length === 0 ? [] : [{ call: call.id, kinds }];
      }),
  });

  router.route({
    method: "get",
    path: "/unattributed",
    summary: "Model calls no session could be given (the agent calling the model at startup, for example)",
    response: z.array(Unattributed).openapi("OpenAIUnattributedCalls"),
    sdkMethod: { on: "OpenAIFixture", name: "unattributed" },
    stability,
    handler: () =>
      world.unattributed().map((call) => ({
        id: call.id,
        endpoint: call.endpoint,
        model: call.request.model,
        at: iso(call.startedAt),
        ...(call.request.lastUserText === undefined ? {} : { lastUserText: call.request.lastUserText.slice(0, 200) }),
        tools: call.request.tools.map((tool) => tool.name ?? tool.type),
      })),
  });

  router.route({
    method: "post",
    path: "/rate-limits",
    summary: "Limit this session's model calls: requests and tokens per window, with truthful x-ratelimit-* headers",
    body: z
      .object({
        requests: z
          .object({ limit: z.number().int().min(0), per: duration("The window. Default 1 minute.").default(60_000) })
          .optional(),
        tokens: z
          .object({ limit: z.number().int().min(0), per: duration("The window. Default 1 minute.").default(60_000) })
          .optional(),
        error: z.enum(["rate_limit", "slow_down"]).default("rate_limit"),
      })
      .openapi("OpenAIRateLimitBody"),
    response: RateLimit,
    factory: { on: "OpenAIFixture", name: "rateLimit", options: ["requests", "tokens", "error"] },
    stability,
    handler: ({ session, body }) => {
      const limiter = world.rateLimit(session.id, {
        ...(body.requests ? { requests: { limit: body.requests.limit, perMs: body.requests.per } } : {}),
        ...(body.tokens ? { tokens: { limit: body.tokens.limit, perMs: body.tokens.per } } : {}),
        error: body.error,
      });
      return { id: session.id, ...limiter.remaining() };
    },
  });

  router.route({
    method: "get",
    path: "/rate-limits/{limit}",
    summary: "What the rate limit's headers would say now",
    params: z.object({ limit: pathParam("limit") }),
    response: RateLimit,
    errors: ["not_found"],
    sdkMethod: { on: "OpenAIRateLimit", name: "remaining" },
    stability,
    handler: ({ session }) => {
      const limiter = world.limiter(session.id);
      if (!limiter) throw new ProtocolError("not_found", "This session has no rate limit");
      return { id: session.id, ...limiter.remaining() };
    },
  });

  router.route({
    method: "delete",
    path: "/rate-limits/{limit}",
    summary: "Remove the rate limit",
    params: z.object({ limit: pathParam("limit") }),
    sdkMethod: { on: "OpenAIRateLimit", name: "undo", dispose: true },
    stability,
    handler: ({ session }) => world.clearRateLimit(session.id),
  });
}
