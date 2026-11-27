import { type Context, Hono } from "hono";

import { bodyOf } from "../../core/fake/endpoint.ts";
import type { DriverContext } from "../../core/router/index.ts";
import { recordCall } from "../../core/router/inspect.ts";
import { constantTimeEqual } from "../../core/signing/hmac.ts";
import { type SseFrame, sseStream, type StreamBreak } from "../../core/stream/index.ts";
import { chatDialect } from "./codecs/answer.ts";
import { chatCompletion, chatErrorFrames, chatFrames, type ChatMeta } from "./codecs/chat.ts";
import {
  finalStatus,
  outputItems,
  responseErrorFrames,
  responseFrames,
  type ResponseMeta,
  responseObject,
} from "./codecs/responses.ts";
import { invalidRequest, notFound, OpenAIError, scriptedError } from "./errors.ts";
import { OPENAI_IDS } from "./ids.ts";
import { defaultRateHeaders } from "./rate-limit.ts";
import { chatRequest, type InputItem, inputItems, type ModelRequest, responsesRequest } from "./request.ts";
import type { Conversation } from "./store.ts";
import type { CallRecord, OpenAIWorld } from "./world.ts";

/** OpenAI's API version header, the same on every answer. */
const OPENAI_VERSION = "2020-10-01";

/** The models `GET /v1/models` lists: current OpenAI ids, plus every name the agent used. Any name is answered. */
const MODELS = [
  "gpt-5.1",
  "gpt-5.1-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
  "o3",
];
/** When the listed models were made: before any test. */
const MODEL_CREATED = 1_735_689_600;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fake OpenAI's HTTP API: what the agent calls. */
export function createOpenAIApi(context: DriverContext, world: OpenAIWorld): Hono {
  const api = new Hono();
  const { ids, clock } = context;
  const organization = ids.next(OPENAI_IDS.organization);
  const project = ids.next(OPENAI_IDS.project);
  const fingerprint = ids.next(OPENAI_IDS.fingerprint);
  const seen = new Set<string>();

  /** What every answer carries: a request id, the version, the organization, and the rate limit's headers. */
  const common = (session: string | undefined, startedAt: number): Record<string, string> => ({
    "x-request-id": ids.next(OPENAI_IDS.request),
    "openai-processing-ms": String(Math.max(1, clock() - startedAt)),
    "openai-version": OPENAI_VERSION,
    "openai-organization": organization,
    "openai-project": project,
    ...(world.limiter(session)?.headers() ?? defaultRateHeaders()),
  });

  const errorResponse = (c: Context, error: OpenAIError, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries({ ...headers, ...error.headers })) c.header(name, value);
    return c.json(error.body(), error.status as 400);
  };

  /** The key the agent sent: `Authorization: Bearer`, or Azure's `api-key`. */
  const authorized = (c: Context): OpenAIError | undefined => {
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
    const key = bearer ?? c.req.header("api-key");
    if (key === undefined || key === "") {
      return new OpenAIError(401, {
        message:
          "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY), or as the password field (with blank username) if you're accessing the API from your browser and are prompted for a username. You can obtain an API key from https://platform.openai.com/account/api-keys.",
        type: "invalid_request_error",
      });
    }
    if (!constantTimeEqual(key, context.secret("apiKey"))) {
      const shown = key.length > 8 ? `${key.slice(0, 3)}*${key.slice(-4)}` : "****";
      return new OpenAIError(401, {
        message: `Incorrect API key provided: ${shown}. You can find your API key at https://platform.openai.com/account/api-keys.`,
        type: "invalid_request_error",
        code: "invalid_api_key",
      });
    }
    return undefined;
  };

  api.use("*", async (c, next) => {
    const refused = authorized(c);
    if (refused) return errorResponse(c, refused, common(undefined, clock()));
    await next();
  });

  /** The call on record in the event log, for `channelstack tail`, the inspector and quiet. */
  const record = (c: Context, call: CallRecord) =>
    recordCall(
      context.events,
      "openai",
      [call.session],
      {
        operation: call.endpoint,
        method: c.req.method,
        path: new URL(c.req.url).pathname.replace(/^\/openai(?=\/)/, ""),
        request: call.body,
        responseStatus: call.status,
        response: call.answer
          ? {
              text: call.answer.text,
              toolCalls: call.answer.toolCalls.map(({ name }) => name),
              finish: call.answer.finish,
            }
          : undefined,
        error: call.error,
        durationMs: call.durationMs ?? 0,
      },
      { unattributed: "world" },
    );

  /** A request the fake refuses before it is a call: recorded for no session. */
  const refuse = (c: Context, operation: string, error: OpenAIError, body: unknown, startedAt: number) => {
    recordCall(
      context.events,
      "openai",
      [],
      {
        operation,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        request: body,
        responseStatus: error.status,
        response: error.body(),
        error: error.code ?? error.type,
        durationMs: clock() - startedAt,
      },
      { unattributed: "world" },
    );
    return errorResponse(c, error, common(undefined, startedAt));
  };

  const parse = async (c: Context): Promise<Json | OpenAIError> => {
    const parsed = await bodyOf(c);
    if ("invalid" in parsed) {
      return invalidRequest(
        "We could not parse the JSON body of your request. (HINT: This likely means you aren't using your HTTP library correctly. The OpenAI API expects a JSON payload, but what was sent was not valid JSON. If you have trouble figuring out how to fix this, please contact us through our help center at help.openai.com.)",
      );
    }
    return parsed.body;
  };

  /** One model call, either endpoint: attributed, answered as its script says, streamed with its timing. */
  const answerCall = async (
    c: Context,
    endpoint: ModelRequest["endpoint"],
    normalise: (body: Json) => { request: ModelRequest; history?: { conversation?: Conversation; previous?: string } },
    overrides: { model?: string } = {},
  ): Promise<Response> => {
    const startedAt = clock();
    const parsed = await parse(c);
    if (parsed instanceof OpenAIError) return refuse(c, endpoint, parsed, undefined, startedAt);
    const body = overrides.model === undefined ? parsed : { ...parsed, model: overrides.model };
    let normalised: ReturnType<typeof normalise>;
    try {
      normalised = normalise(body);
    } catch (error) {
      if (error instanceof OpenAIError) return refuse(c, endpoint, error, body, startedAt);
      throw error;
    }
    const { request } = normalised;
    seen.add(request.model);
    const call = world.begin(request, body, c.req.raw.headers);
    call.open = "a model call in flight";
    const outcome = await world.outcome(call, c.req.raw.signal);

    const done = (result: Parameters<OpenAIWorld["finish"]>[1]) => {
      world.finish(call, result);
      record(c, call);
    };

    if (outcome.kind === "timeout") {
      call.open = "a model call that never answers (a scripted timeout)";
      await new Promise<void>((resolve) => {
        if (c.req.raw.signal.aborted) resolve();
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
      done({ status: 0, end: "aborted", error: "timeout" });
      return new Response(null, { status: 408 });
    }
    if (outcome.kind === "error") {
      await world.wait(outcome.afterMs);
      done({ status: outcome.error.status, error: outcome.error.code ?? outcome.error.type });
      return errorResponse(c, outcome.error, common(call.session, startedAt));
    }

    const { answer, turn, script } = outcome;
    call.answer = answer;
    const created = Math.floor(startedAt / 1000);
    const chatMeta: ChatMeta = {
      id: call.id,
      created,
      model: request.model,
      fingerprint,
      dialect: chatDialect(request, body),
    };
    const store = endpoint === "responses" && body.store !== false;
    const encrypted =
      request.includes.includes("reasoning.encrypted_content") && answer.reasoning
        ? `gAAAAA${ids.next(OPENAI_IDS.held).slice(5)}${answer.reasoning.itemId.slice(3)}`
        : undefined;
    const responseMeta: ResponseMeta = {
      id: call.id,
      created,
      model: request.model,
      body,
      ...(normalised.history?.previous === undefined ? {} : { previousResponseId: normalised.history.previous }),
      ...(normalised.history?.conversation === undefined ? {} : { conversation: normalised.history.conversation.id }),
      store,
      ...(encrypted === undefined ? {} : { encryptedReasoning: encrypted }),
      obfuscation: request.includeObfuscation,
    };

    /** A finished Responses answer is stored, and its conversation grows by its input and output. */
    const keep = () => {
      if (endpoint !== "responses") return;
      const own = inputItems(body.input).map((item) =>
        item.id === undefined && (item.type ?? "message") === "message"
          ? { ...item, id: ids.next(OPENAI_IDS.message) }
          : item,
      );
      const output = outputItems(answer, responseMeta);
      const conversation = normalised.history?.conversation;
      if (conversation) {
        conversation.items.push(...own, ...output);
        conversation.session ??= call.session;
      }
      if (store) {
        const history =
          normalised.history?.previous === undefined ? [] : (world.store.history(normalised.history.previous) ?? []);
        world.store.keep({
          id: call.id,
          session: call.session,
          input: [...(conversation ? [] : history), ...own],
          output,
          object: responseObject(answer, responseMeta, finalStatus(answer)),
        });
      }
    };

    const timing = turn.timing ?? {};
    if (!request.stream) {
      await world.wait(timing.firstToken ?? 0);
      keep();
      done({ status: 200 });
      const headers = common(call.session, startedAt);
      for (const [name, value] of Object.entries(headers)) c.header(name, value);
      return c.json(
        endpoint === "chat.completions"
          ? chatCompletion(answer, chatMeta)
          : responseObject(answer, responseMeta, finalStatus(answer)),
      );
    }

    const frames: SseFrame[] =
      endpoint === "chat.completions"
        ? chatFrames(answer, chatMeta, request.includeUsage)
        : responseFrames(answer, responseMeta);
    let breaking: StreamBreak | undefined;
    if (turn.failAfter !== undefined) {
      const { chunks, how } = turn.failAfter;
      const failure = scriptedError("server_error", { model: request.model, endpoint });
      let seenContent = 0;
      const cut = frames.findIndex((frame) => frame.content === true && seenContent++ === chunks);
      breaking = {
        chunks,
        how,
        ...(how === "error"
          ? {
              errorFrames:
                endpoint === "chat.completions"
                  ? chatErrorFrames(failure)
                  : responseErrorFrames(responseMeta, failure, cut === -1 ? frames.length : cut),
            }
          : {}),
      };
    }
    await world.wait(timing.firstToken ?? 0);
    const stream = sseStream(
      {
        frames,
        betweenMs: timing.betweenChunks ?? 0,
        ...(breaking ? { break: breaking } : {}),
        ...(turn.pauseAfter === undefined ? {} : { pauseAfter: turn.pauseAfter }),
      },
      context.timers,
      {
        paused: () => {
          call.open = `a model stream paused after ${turn.pauseAfter} chunks by ${script.id}`;
          script.paused.set(call.id, () => stream.resume());
        },
        stalled: (chunks) => {
          call.open = `a model stream that stalled after ${chunks} chunks`;
        },
        ended: (end, chunksSent) => {
          script.paused.delete(call.id);
          if (end === "completed") keep();
          done({ status: 200, end, chunksSent, ...(end === "errored" ? { error: "server_error" } : {}) });
        },
      },
    );
    return new Response(stream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...common(call.session, startedAt),
      },
    });
  };

  const chat = (c: Context, model?: string) =>
    answerCall(
      c,
      "chat.completions",
      (body) => ({ request: chatRequest(body, c.req.raw.headers) }),
      model === undefined ? {} : { model },
    );

  const responses = (c: Context) =>
    answerCall(c, "responses", (body) => {
      const previous = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
      const conversationId =
        typeof body.conversation === "string"
          ? body.conversation
          : isObject(body.conversation) && typeof body.conversation.id === "string"
            ? body.conversation.id
            : undefined;
      if (previous !== undefined && conversationId !== undefined) {
        throw invalidRequest(
          "Mutually exclusive parameters: Ensure you are only providing one of: 'previous_response_id' or 'conversation'.",
          null,
          "mutually_exclusive_parameters",
        );
      }
      let history: readonly InputItem[] = [];
      let conversation: Conversation | undefined;
      if (previous !== undefined) {
        const found = world.store.history(previous);
        if (found === undefined) {
          throw invalidRequest(
            `Previous response with id '${previous}' not found.`,
            "previous_response_id",
            "previous_response_not_found",
          );
        }
        history = found;
      }
      if (conversationId !== undefined) {
        conversation = world.store.conversations.get(conversationId);
        if (!conversation)
          throw new OpenAIError(404, {
            message: `Conversation with id '${conversationId}' not found.`,
            type: "invalid_request_error",
            param: "conversation",
          });
        history = conversation.items;
      }
      return {
        request: responsesRequest(body, c.req.raw.headers, history),
        history: {
          ...(previous === undefined ? {} : { previous }),
          ...(conversation === undefined ? {} : { conversation }),
        },
      };
    });

  // --- The endpoints -------------------------------------------------------------------------

  const v1 = new Hono();
  v1.post("/chat/completions", (c) => chat(c));
  v1.post("/responses", (c) => responses(c));

  const plain = (c: Context, body: unknown, status = 200) => {
    for (const [name, value] of Object.entries(common(undefined, clock()))) c.header(name, value);
    return c.json(body, status as 200);
  };
  const missing = (c: Context, message: string, param: string | null = null) =>
    errorResponse(
      c,
      new OpenAIError(404, { message, type: "invalid_request_error", param }),
      common(undefined, clock()),
    );

  v1.get("/responses/:id", (c) => {
    const stored = world.store.responses.get(c.req.param("id"));
    return stored ? plain(c, stored.object) : missing(c, `Response with id '${c.req.param("id")}' not found.`);
  });
  v1.delete("/responses/:id", (c) => {
    const id = c.req.param("id");
    if (!world.store.responses.delete(id)) return missing(c, `Response with id '${id}' not found.`);
    return plain(c, { id, object: "response", deleted: true });
  });
  v1.get("/responses/:id/input_items", (c) => {
    const stored = world.store.responses.get(c.req.param("id"));
    if (!stored) return missing(c, `Response with id '${c.req.param("id")}' not found.`);
    return plain(c, listOf([...stored.input].reverse()));
  });

  // Conversations: their items are the history of the responses that name them.
  v1.post("/conversations", async (c) => {
    const parsed = await parse(c);
    if (parsed instanceof OpenAIError) return errorResponse(c, parsed, common(undefined, clock()));
    const conversation = world.store.openConversation({
      id: ids.next(OPENAI_IDS.conversation),
      createdAt: Math.floor(clock() / 1000),
      metadata: isObject(parsed.metadata) ? (parsed.metadata as Record<string, string>) : {},
      items: inputItems(parsed.items).map((item) => withId(item)),
      session: undefined,
    });
    return plain(c, conversationWire(conversation));
  });
  v1.get("/conversations/:id", (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    return conversation
      ? plain(c, conversationWire(conversation))
      : missing(c, `Conversation with id '${c.req.param("id")}' not found.`);
  });
  v1.post("/conversations/:id", async (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    if (!conversation) return missing(c, `Conversation with id '${c.req.param("id")}' not found.`);
    const parsed = await parse(c);
    if (parsed instanceof OpenAIError) return errorResponse(c, parsed, common(undefined, clock()));
    if (isObject(parsed.metadata)) conversation.metadata = parsed.metadata as Record<string, string>;
    return plain(c, conversationWire(conversation));
  });
  v1.delete("/conversations/:id", (c) => {
    const id = c.req.param("id");
    if (!world.store.conversations.delete(id)) return missing(c, `Conversation with id '${id}' not found.`);
    return plain(c, { id, object: "conversation.deleted", deleted: true });
  });
  v1.get("/conversations/:id/items", (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    if (!conversation) return missing(c, `Conversation with id '${c.req.param("id")}' not found.`);
    const order = c.req.query("order") === "asc" ? "asc" : "desc";
    return plain(c, listOf(order === "asc" ? conversation.items : [...conversation.items].reverse()));
  });
  v1.post("/conversations/:id/items", async (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    if (!conversation) return missing(c, `Conversation with id '${c.req.param("id")}' not found.`);
    const parsed = await parse(c);
    if (parsed instanceof OpenAIError) return errorResponse(c, parsed, common(undefined, clock()));
    const added = inputItems(parsed.items).map((item) => withId(item));
    conversation.items.push(...added);
    return plain(c, listOf(added));
  });
  v1.get("/conversations/:id/items/:item", (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    const item = conversation?.items.find((candidate) => candidate.id === c.req.param("item"));
    return item ? plain(c, item) : missing(c, `Item with id '${c.req.param("item")}' not found.`);
  });
  v1.delete("/conversations/:id/items/:item", (c) => {
    const conversation = world.store.conversations.get(c.req.param("id"));
    const at = conversation?.items.findIndex((candidate) => candidate.id === c.req.param("item")) ?? -1;
    if (!conversation || at === -1) return missing(c, `Item with id '${c.req.param("item")}' not found.`);
    conversation.items.splice(at, 1);
    return plain(c, conversationWire(conversation));
  });

  v1.get("/models", (c) =>
    plain(c, {
      object: "list",
      data: [...new Set([...MODELS, ...seen])].map((id) => ({
        id,
        object: "model",
        created: MODEL_CREATED,
        owned_by: "system",
      })),
    }),
  );
  v1.get("/models/:model", (c) =>
    plain(c, { id: c.req.param("model"), object: "model", created: MODEL_CREATED, owned_by: "system" }),
  );

  const withId = (item: InputItem): InputItem =>
    item.id === undefined
      ? { ...item, id: ids.next(OPENAI_IDS.message), ...(item.type === undefined ? { type: "message" } : {}) }
      : item;
  const conversationWire = (conversation: Conversation) => ({
    id: conversation.id,
    object: "conversation",
    created_at: conversation.createdAt,
    metadata: conversation.metadata,
  });

  api.route("/v1", v1);
  // Azure OpenAI's v1 API, and its deployment paths: the deployment is the model, `api-version` is required.
  api.route("/openai/v1", v1);
  api.post("/openai/deployments/:deployment/chat/completions", (c) => {
    if (c.req.query("api-version") === undefined) {
      return errorResponse(
        c,
        new OpenAIError(404, { message: "Resource not found", type: "invalid_request_error", code: "404" }),
        common(undefined, clock()),
      );
    }
    return chat(c, c.req.param("deployment"));
  });

  api.all("*", (c) =>
    errorResponse(c, notFound(c.req.method, new URL(c.req.url).pathname), common(undefined, clock())),
  );
  return api;
}

/** A list as OpenAI pages one: `object: "list"`, its first and last ids, and no more. */
function listOf(items: readonly InputItem[]) {
  return {
    object: "list",
    data: items,
    first_id: (items[0]?.id as string | undefined) ?? null,
    last_id: (items.at(-1)?.id as string | undefined) ?? null,
    has_more: false,
  };
}
