import { type Context, Hono } from "hono";

import { bodyOf } from "../../core/fake/endpoint.ts";
import type { DriverContext } from "../../core/router/index.ts";
import { recordCall } from "../../core/router/inspect.ts";
import { constantTimeEqual } from "../../core/signing/hmac.ts";
import { type SseFrame, sseStream, type StreamBreak } from "../../core/stream/index.ts";
import { type Answer, chatDialect } from "./codecs/answer.ts";
import { chatCompletion, chatErrorFrames, chatFrames, type ChatMeta } from "./codecs/chat.ts";
import { imagesResponse, speechFrames, transcriptBody, transcriptFrames } from "./codecs/media.ts";
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
import {
  containerFileWire,
  fileWire,
  FORMAT_TYPES,
  type Media,
  type ModelPart,
  readPart,
  sha256,
  sniff,
} from "./media.ts";
import { defaultRateHeaders } from "./rate-limit.ts";
import {
  chatRequest,
  type InputItem,
  inputItems,
  mediaRequest,
  type ModelRequest,
  responsesRequest,
} from "./request.ts";
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
    // What the Images API answered with as a URL is served without a key, as OpenAI's own links are.
    if (/^(?:\/openai)?\/generated\//.test(new URL(c.req.url).pathname)) return next();
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

  /** Every part of a request with its bytes read: data URLs, `file_id`s, URLs on a fake host (design §5.5). */
  const readParts = async (request: ModelRequest): Promise<ModelRequest> => {
    const read = (part: ModelPart) => readPart(part, world.media, (url) => context.fetchFake(url));
    const messages = await Promise.all(
      request.messages.map(async (message) =>
        message.role === "user" ? { ...message, parts: await Promise.all(message.parts.map(read)) } : message,
      ),
    );
    const { media } = request;
    return {
      ...request,
      messages,
      ...(request.file === undefined ? {} : { file: await read(request.file) }),
      ...(media === undefined
        ? {}
        : {
            media: {
              ...media,
              images: await Promise.all(media.images.map(read)),
              ...(media.mask === undefined ? {} : { mask: await read(media.mask) }),
            },
          }),
    };
  };

  /** The files of a multipart body, by field: the body a call records names each by its hash instead. */
  const uploads = new WeakMap<object, Record<string, Media[]>>();

  /**
   * A multipart body (the media endpoints' uploads, `/v1/files`), or JSON: its fields, with each
   * file as `{ filename, mediaType, bytes, sha256 }`, and the bytes kept in `uploads`.
   */
  const readForm = async (c: Context): Promise<Json | OpenAIError> => {
    if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) return parse(c);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return invalidRequest("We could not parse the multipart form body of your request.");
    }
    const body: Json = {};
    const files: Record<string, Media[]> = {};
    for (const [key, value] of Object.entries(form)) {
      const name = key.replace(/\[\]$/, "");
      const described: unknown[] = [];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (!(entry instanceof File)) {
          described.push(entry);
          continue;
        }
        const bytes = new Uint8Array(await entry.arrayBuffer());
        const extension = entry.name.split(".").at(-1)?.toLowerCase() ?? "";
        const mediaType = sniff(bytes) ?? (entry.type || FORMAT_TYPES[extension] || "application/octet-stream");
        const list = files[name] ?? [];
        list.push({ bytes, mediaType, filename: entry.name });
        files[name] = list;
        described.push({ filename: entry.name, mediaType, bytes: bytes.length, sha256: sha256(bytes) });
      }
      body[name] = described.length === 1 && !key.endsWith("[]") ? described[0] : described;
    }
    uploads.set(body, files);
    return body;
  };

  /** An uploaded file as a part of the request, its bytes already read. */
  const uploaded =
    (type: ModelPart["type"]) =>
    (media: Media): ModelPart => ({
      type,
      from: "data",
      mediaType: media.mediaType,
      bytes: media.bytes.length,
      sha256: sha256(media.bytes),
      ...(media.filename === undefined ? {} : { filename: media.filename }),
    });

  /** An image a JSON body names: `{ image_url }` (a URL or a data URL) or `{ file_id }`. */
  const namedImage = (value: unknown): ModelPart | undefined => {
    if (!isObject(value)) return undefined;
    if (typeof value.file_id === "string") return { type: "image", from: "file_id", fileId: value.file_id };
    if (typeof value.image_url !== "string") return undefined;
    return value.image_url.startsWith("data:")
      ? { type: "image", from: "data", pending: { data: value.image_url } }
      : { type: "image", from: "url", url: value.image_url };
  };

  /** One model call, any endpoint: attributed, answered as its script says, streamed with its timing. */
  const answerCall = async (
    c: Context,
    endpoint: ModelRequest["endpoint"],
    normalise: (body: Json) => { request: ModelRequest; history?: { conversation?: Conversation; previous?: string } },
    overrides: { model?: string; read?: (c: Context) => Promise<Json | OpenAIError> } = {},
  ): Promise<Response> => {
    const startedAt = clock();
    const parsed = await (overrides.read ?? parse)(c);
    if (parsed instanceof OpenAIError) return refuse(c, endpoint, parsed, undefined, startedAt);
    const body = overrides.model === undefined ? parsed : { ...parsed, model: overrides.model };
    let normalised: ReturnType<typeof normalise>;
    let request: ModelRequest;
    try {
      normalised = normalise(body);
      request = await readParts(normalised.request);
    } catch (error) {
      if (error instanceof OpenAIError) return refuse(c, endpoint, error, body, startedAt);
      throw error;
    }
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
    if (encrypted !== undefined) world.store.issued.add(encrypted);
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
      const own = inputItems(body.input).map((item) => withId(item));
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
    // Speech streams when `stream_format: "sse"` asks; the other endpoints when `stream` does.
    const streamed = request.stream || request.media?.streamFormat === "sse";
    if (!streamed) {
      await world.wait(timing.firstToken ?? 0);
      keep();
      done({ status: 200 });
      const headers = common(call.session, startedAt);
      for (const [name, value] of Object.entries(headers)) c.header(name, value);
      return whole(c, endpoint, answer, request, body, { chatMeta, responseMeta, created });
    }

    const frames: SseFrame[] =
      endpoint === "chat.completions"
        ? chatFrames(answer, chatMeta, request.includeUsage)
        : endpoint === "responses"
          ? responseFrames(answer, responseMeta)
          : endpoint === "audio.speech"
            ? speechFrames(answer)
            : transcriptFrames(answer);
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
                endpoint === "responses"
                  ? responseErrorFrames(responseMeta, failure, cut === -1 ? frames.length : cut)
                  : chatErrorFrames(failure),
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

  /** Where an image answered as a URL is served: on the fake's own address, without a key. */
  const imageUrl = (media: Media) => {
    const name = `${ids.next(OPENAI_IDS.generated)}.${media.mediaType.split("/")[1] ?? "png"}`;
    world.media.keepGenerated(name, media);
    return `${context.apiUrl()}/generated/${name}`;
  };

  /** A whole answer, in the endpoint's format: an object, the audio's bytes, or a transcript's text. */
  const whole = (
    c: Context,
    endpoint: ModelRequest["endpoint"],
    answer: Answer,
    request: ModelRequest,
    body: Json,
    meta: { chatMeta: ChatMeta; responseMeta: ResponseMeta; created: number },
  ): Response => {
    switch (endpoint) {
      case "chat.completions":
        return c.json(chatCompletion(answer, meta.chatMeta));
      case "responses":
        return c.json(responseObject(answer, meta.responseMeta, finalStatus(answer)));
      case "images.generations":
      case "images.edits":
        return c.json(imagesResponse(answer, request, { created: meta.created, imageUrl }));
      case "audio.speech": {
        const audio = answer.media?.audio;
        c.header("content-type", audio?.mediaType ?? "audio/mpeg");
        return c.body((audio?.bytes ?? new Uint8Array()) as Uint8Array<ArrayBuffer>);
      }
      default: {
        const transcript = transcriptBody(answer, request, uploads.get(body)?.file?.[0]);
        return "json" in transcript ? c.json(transcript.json) : c.text(transcript.text);
      }
    }
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
      // Reasoning sent back must be what the fake gave out, as OpenAI only decrypts its own.
      for (const item of inputItems(body.input)) {
        const blob = item.type === "reasoning" ? item.encrypted_content : undefined;
        if (typeof blob === "string" && !world.store.issued.has(blob)) {
          throw invalidRequest(
            "The encrypted content for item could not be verified.",
            "input",
            "invalid_encrypted_content",
          );
        }
      }
      // An item reference stands for the stored item it names, as OpenAI reads it.
      const input = inputItems(body.input).flatMap((item) => {
        const named =
          item.type === "item_reference" && typeof item.id === "string" ? world.store.item(item.id) : undefined;
        return named === undefined ? [item] : [named, item];
      });
      return {
        request: responsesRequest({ ...body, input }, c.req.raw.headers, history),
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

  // The media endpoints (design §5.5): answered by scripts like any model call.
  const headersOf = (c: Context) => c.req.raw.headers;
  v1.post("/images/generations", (c) =>
    answerCall(c, "images.generations", (body) => ({
      request: mediaRequest("images.generations", body, {}, headersOf(c)),
    })),
  );
  v1.post("/images/edits", (c) =>
    answerCall(
      c,
      "images.edits",
      (body) => {
        const files = uploads.get(body) ?? {};
        const named = (Array.isArray(body.images) ? body.images : []).map(namedImage);
        const images = [
          ...(files.image ?? []).map(uploaded("image")),
          ...named.filter((part): part is ModelPart => part !== undefined),
        ];
        const mask = files.mask?.[0] === undefined ? namedImage(body.mask) : uploaded("image")(files.mask[0]);
        return {
          request: mediaRequest(
            "images.edits",
            body,
            { images, ...(mask === undefined ? {} : { mask }) },
            headersOf(c),
          ),
        };
      },
      { read: readForm },
    ),
  );
  v1.post("/audio/speech", (c) =>
    answerCall(c, "audio.speech", (body) => ({ request: mediaRequest("audio.speech", body, {}, headersOf(c)) })),
  );
  for (const [path, endpoint] of [
    ["/audio/transcriptions", "audio.transcriptions"],
    ["/audio/translations", "audio.translations"],
  ] as const) {
    v1.post(path, (c) =>
      answerCall(
        c,
        endpoint,
        (body) => {
          const file = uploads.get(body)?.file?.[0];
          return {
            request: mediaRequest(
              endpoint,
              body,
              file === undefined ? {} : { file: uploaded("audio")(file) },
              headersOf(c),
            ),
          };
        },
        { read: readForm },
      ),
    );
  }

  // Files: what `file_id` parts name, and what file search cites.
  const PURPOSES = ["assistants", "batch", "fine-tune", "vision", "user_data", "evals"];
  const noFile = (c: Context, id: string) =>
    errorResponse(
      c,
      new OpenAIError(404, { message: `No such File object: ${id}`, type: "invalid_request_error", param: "id" }),
      common(undefined, clock()),
    );
  v1.post("/files", async (c) => {
    const parsed = await readForm(c);
    if (parsed instanceof OpenAIError) return errorResponse(c, parsed, common(undefined, clock()));
    const file = uploads.get(parsed)?.file?.[0];
    const purpose = typeof parsed.purpose === "string" ? parsed.purpose : undefined;
    const refuse400 = (message: string, param: string) =>
      errorResponse(c, invalidRequest(message, param), common(undefined, clock()));
    if (file === undefined) return refuse400("Missing required parameter: 'file'.", "file");
    if (purpose === undefined) return refuse400("Missing required parameter: 'purpose'.", "purpose");
    if (!PURPOSES.includes(purpose)) {
      return refuse400(
        `'${purpose}' is not one of ${PURPOSES.map((name) => `'${name}'`).join(", ")} - 'purpose'`,
        "purpose",
      );
    }
    const created = Math.floor(clock() / 1000);
    const seconds = Number((parsed as { "expires_after[seconds]"?: unknown })["expires_after[seconds]"]);
    const stored = world.media.keepFile({
      ...file,
      id: ids.next(OPENAI_IDS.file),
      filename: file.filename ?? "file",
      purpose,
      createdAt: created,
      ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: created + seconds } : {}),
    });
    return plain(c, fileWire(stored));
  });
  v1.get("/files", (c) => {
    const purpose = c.req.query("purpose");
    const files = [...world.media.files.values()].filter((file) => purpose === undefined || file.purpose === purpose);
    const ordered = c.req.query("order") === "asc" ? files : files.reverse();
    return plain(c, listOf(ordered.map(fileWire)));
  });
  v1.get("/files/:id", (c) => {
    const file = world.media.files.get(c.req.param("id"));
    return file ? plain(c, fileWire(file)) : noFile(c, c.req.param("id"));
  });
  v1.delete("/files/:id", (c) => {
    const id = c.req.param("id");
    if (!world.media.files.delete(id)) return noFile(c, id);
    return plain(c, { id, object: "file", deleted: true });
  });
  v1.get("/files/:id/content", (c) => {
    const file = world.media.files.get(c.req.param("id"));
    if (!file) return noFile(c, c.req.param("id"));
    for (const [name, value] of Object.entries(common(undefined, clock()))) c.header(name, value);
    c.header("content-type", "application/octet-stream");
    return c.body(file.bytes as Uint8Array<ArrayBuffer>);
  });

  // A code interpreter's container: the files its code wrote.
  const containerOf = (c: Context) => world.media.containers.get(c.req.param("container") ?? "");
  const noContainer = (c: Context, what: string) =>
    errorResponse(
      c,
      new OpenAIError(404, { message: `${what} not found.`, type: "invalid_request_error", param: null }),
      common(undefined, clock()),
    );
  v1.get("/containers/:container/files", (c) => {
    const files = containerOf(c);
    if (!files) return noContainer(c, `Container ${c.req.param("container")}`);
    return plain(c, listOf([...files.values()].map(containerFileWire)));
  });
  v1.get("/containers/:container/files/:file", (c) => {
    const file = containerOf(c)?.get(c.req.param("file"));
    return file ? plain(c, containerFileWire(file)) : noContainer(c, `File ${c.req.param("file")}`);
  });
  v1.get("/containers/:container/files/:file/content", (c) => {
    const file = containerOf(c)?.get(c.req.param("file"));
    if (!file) return noContainer(c, `File ${c.req.param("file")}`);
    for (const [name, value] of Object.entries(common(undefined, clock()))) c.header(name, value);
    c.header("content-type", file.mediaType);
    return c.body(file.bytes as Uint8Array<ArrayBuffer>);
  });

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

  /**
   * An input item as OpenAI keeps it, in a conversation or a response's input: an id, a status,
   * and a message's content as parts (`input_text`; the model's own as `output_text`).
   */
  function withId(item: InputItem): InputItem {
    const type = typeof item.type === "string" ? item.type : "message";
    const id =
      typeof item.id === "string"
        ? item.id
        : ids.next(type === "message" ? OPENAI_IDS.message : OPENAI_IDS.functionCall);
    if (type !== "message") return { ...item, type, id, status: item.status ?? "completed" };
    const role = typeof item.role === "string" ? item.role : "user";
    const kind = role === "assistant" ? "output_text" : "input_text";
    const content =
      typeof item.content === "string"
        ? [{ type: kind, text: item.content, ...(kind === "output_text" ? { annotations: [] } : {}) }]
        : item.content;
    return { ...item, type, id, status: item.status ?? "completed", role, content };
  }
  const conversationWire = (conversation: Conversation) => ({
    id: conversation.id,
    object: "conversation",
    created_at: conversation.createdAt,
    metadata: conversation.metadata,
  });

  api.get("/generated/:name", (c) => {
    const media = world.media.generated.get(c.req.param("name"));
    if (!media) return c.body(null, 404);
    c.header("content-type", media.mediaType);
    return c.body(media.bytes as Uint8Array<ArrayBuffer>);
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
function listOf(items: readonly Record<string, unknown>[]) {
  return {
    object: "list",
    data: items,
    first_id: (items[0]?.id as string | undefined) ?? null,
    last_id: (items.at(-1)?.id as string | undefined) ?? null,
    has_more: false,
  };
}
