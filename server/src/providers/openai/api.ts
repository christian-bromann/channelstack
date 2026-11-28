import { type Context, Hono } from "hono";

import { bodyOf, recordAs, type RestAnswer, type StreamOutcome, wrapRest } from "../../core/fake/endpoint.ts";
import type { DriverContext } from "../../core/router/index.ts";
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
  type Media,
  mediaTypeOf,
  type ModelPart,
  partOf,
  readPart,
  sha256,
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

/**
 * What a request keeps on its context: the session its call belongs to, the session whose rate
 * limit a model call counts against, when it arrived, whether its key was good.
 */
const SESSION = "openaiSession";
const LIMITED = "openaiLimitedBy";
const STARTED = "openaiStartedAt";
const AUTHENTICATED = "openaiAuthenticated";
const sessionOf = (c: Context) => c.get(SESSION as never) as string | undefined;
const belongsTo = (c: Context, session: string | undefined) => c.set(SESSION as never, session as never);

/** OpenAI's refusal as the kit answers it: its body, status and headers. */
const refusalOf = (error: OpenAIError): RestAnswer => ({
  body: error.body(),
  status: error.status,
  headers: error.headers,
  sessions: [],
});

/** The fake OpenAI's HTTP API: what the agent calls, on the REST kit (`wrapRest`). */
export function createOpenAIApi(context: DriverContext, world: OpenAIWorld): Hono {
  const api = new Hono();
  const { ids, clock } = context;
  const { organization } = world;
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
    c.set(STARTED as never, clock() as never);
    // What the Images API answered with as a URL is served without a key, as OpenAI's own links are.
    if (/^(?:\/openai)?\/generated\//.test(new URL(c.req.url).pathname)) return next();
    const refused = authorized(c);
    if (refused) throw refused;
    c.set(AUTHENTICATED as never, true as never);
    await next();
  });

  const parse = async (c: Context): Promise<Json> => {
    const parsed = await bodyOf(c);
    if ("invalid" in parsed) {
      throw invalidRequest(
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
    // A media endpoint's file is its message's first part: read once, with the others.
    const first = messages[0]?.role === "user" ? messages[0].parts[0] : undefined;
    return { ...request, messages, ...(request.file === undefined || first === undefined ? {} : { file: first }) };
  };

  /** The files of a multipart body, by field: the body a call records names each by its hash instead. */
  const uploads = new WeakMap<object, Record<string, Media[]>>();

  /**
   * A multipart body (the media endpoints' uploads, `/v1/files`), or JSON: its fields, with each
   * file as `{ filename, mediaType, bytes, sha256 }`, and the bytes kept in `uploads`.
   */
  const readForm = async (c: Context): Promise<Json> => {
    if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) return parse(c);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      throw invalidRequest("We could not parse the multipart form body of your request.");
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
        const mediaType = mediaTypeOf(bytes, entry.type === "" ? undefined : entry.type, entry.name);
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
    (media: Media): ModelPart =>
      partOf({ type, from: "data" }, media);

  /** An image a JSON body names: `{ image_url }` (a URL or a data URL) or `{ file_id }`. */
  const namedImage = (value: unknown): ModelPart | undefined => {
    if (!isObject(value)) return undefined;
    if (typeof value.file_id === "string") return { type: "image", from: "file_id", fileId: value.file_id };
    if (typeof value.image_url !== "string") return undefined;
    return value.image_url.startsWith("data:")
      ? { type: "image", from: "data", pending: { data: value.image_url } }
      : { type: "image", from: "url", url: value.image_url };
  };

  /**
   * One model call, any endpoint: attributed, answered as its script says, streamed with its
   * timing. It goes on record when it ends: answered, refused, cut, or abandoned by the agent.
   */
  const answerCall = async (
    c: Context,
    endpoint: ModelRequest["endpoint"],
    normalise: (body: Json) => { request: ModelRequest; history?: { conversation?: Conversation; previous?: string } },
    overrides: { model?: string; read?: (c: Context) => Promise<Json> } = {},
  ): Promise<Response> => {
    recordAs(c, { operation: endpoint });
    const startedAt = clock();
    const parsed = await (overrides.read ?? parse)(c);
    const body = overrides.model === undefined ? parsed : { ...parsed, model: overrides.model };
    const normalised = normalise(body);
    const request = await readParts(normalised.request);
    world.scripts.refuseInvalidSchemas(request);
    seen.add(request.model);
    const call = world.begin(request, body, c.req.raw.headers);
    belongsTo(c, call.session);
    c.set(LIMITED as never, call.session as never);
    let ended: (outcome: StreamOutcome) => void = () => {};
    recordAs(c, { operation: endpoint, ended: new Promise((resolve) => (ended = resolve)) });
    call.open = "a model call in flight";

    const done = (result: Parameters<OpenAIWorld["finish"]>[1], response: unknown = summary(call)) => {
      world.finish(call, result);
      ended({ status: call.status, response, ...(call.error === undefined ? {} : { error: call.error }) });
    };
    try {
      return await reply(c, endpoint, call, body, normalised, startedAt, done);
    } catch (error) {
      // Whatever went wrong, the call ends: on record, not in flight, and a problem of its session
      // unless it is OpenAI's own refusal.
      if (!call.done) {
        if (error instanceof OpenAIError) done({ status: error.status, error: error.code ?? error.type }, error.body());
        else {
          world.problem(
            call.session,
            `the fake OpenAI failed answering ${call.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          done({ status: 500, error: "server_error" });
        }
      }
      throw error;
    }
  };

  /** What answers a call once it is on record: its outcome, held, streamed or refused. `done` ends it. */
  const reply = async (
    c: Context,
    endpoint: ModelRequest["endpoint"],
    call: CallRecord,
    body: Json,
    normalised: { request: ModelRequest; history?: { conversation?: Conversation; previous?: string } },
    startedAt: number,
    done: (result: Parameters<OpenAIWorld["finish"]>[1], response?: unknown) => void,
  ): Promise<Response> => {
    const { request } = normalised;
    const hangUp = c.req.raw.signal;
    const outcome = await world.outcome(call, hangUp);
    /** The agent hung up before anything was sent: nothing is stored, and the call is `aborted`. */
    const abandoned = () => {
      done({ status: 0, end: "aborted" });
      return new Response(null, { status: 499 });
    };

    if (outcome.kind === "aborted") return abandoned();
    if (outcome.kind === "timeout") {
      call.open = "a model call that never answers (a scripted timeout)";
      await new Promise<void>((resolve) => {
        if (hangUp.aborted) resolve();
        hangUp.addEventListener("abort", () => resolve(), { once: true });
      });
      done({ status: 0, end: "aborted", error: "timeout" });
      return new Response(null, { status: 408 });
    }
    if (outcome.kind === "error") {
      if (await world.firstToken(call, outcome.firstTokenMs, hangUp)) return abandoned();
      done({ status: outcome.error.status, error: outcome.error.code ?? outcome.error.type }, outcome.error.body());
      throw outcome.error;
    }

    const { answer, turn, script } = outcome;
    call.answer = answer;
    const created = Math.floor(startedAt / 1000);
    const dialect = chatDialect(request, body);
    const chatMeta: ChatMeta = {
      id: call.id,
      created,
      model: request.model,
      fingerprint,
      dialect,
      // OpenAI pads its own streams; the gateways' dialects don't.
      obfuscation: request.includeObfuscation && dialect === "openai",
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
    if (await world.firstToken(call, timing.firstToken ?? 0, hangUp)) return abandoned();
    if (!streamed) {
      keep();
      done({ status: 200 });
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
      return {
        request: responsesRequest(body, c.req.raw.headers, history, (id) => world.store.item(id)),
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
  const noFile = (id: string) =>
    new OpenAIError(404, { message: `No such File object: ${id}`, type: "invalid_request_error", param: "id" });
  const fileOf = (c: Context) => {
    const id = c.req.param("id") ?? "";
    const file = world.media.files.get(id);
    if (!file) throw noFile(id);
    return file;
  };
  v1.post("/files", async (c) => {
    const parsed = await readForm(c);
    const file = uploads.get(parsed)?.file?.[0];
    const purpose = typeof parsed.purpose === "string" ? parsed.purpose : undefined;
    if (file === undefined) throw invalidRequest("Missing required parameter: 'file'.", "file");
    if (purpose === undefined) throw invalidRequest("Missing required parameter: 'purpose'.", "purpose");
    if (!PURPOSES.includes(purpose)) {
      throw invalidRequest(
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
    return c.json(fileWire(stored));
  });
  v1.get("/files", (c) => {
    const purpose = c.req.query("purpose");
    const files = [...world.media.files.values()].filter((file) => purpose === undefined || file.purpose === purpose);
    const ordered = c.req.query("order") === "asc" ? files : files.reverse();
    return c.json(listOf(ordered.map(fileWire)));
  });
  v1.get("/files/:id", (c) => c.json(fileWire(fileOf(c))));
  v1.delete("/files/:id", (c) => {
    const { id } = fileOf(c);
    world.media.files.delete(id);
    return c.json({ id, object: "file", deleted: true });
  });
  v1.get("/files/:id/content", (c) => {
    const file = fileOf(c);
    c.header("content-type", "application/octet-stream");
    return c.body(file.bytes as Uint8Array<ArrayBuffer>);
  });

  // A code interpreter's container: the files its code wrote.
  const notFoundIn = (what: string) =>
    new OpenAIError(404, { message: `${what} not found.`, type: "invalid_request_error", param: null });
  const containerOf = (c: Context) => {
    const files = world.media.containers.get(c.req.param("container") ?? "");
    if (!files) throw notFoundIn(`Container ${c.req.param("container") ?? ""}`);
    return files;
  };
  const containerFileOf = (c: Context) => {
    const file = containerOf(c).get(c.req.param("file") ?? "");
    if (!file) throw notFoundIn(`File ${c.req.param("file") ?? ""}`);
    return file;
  };
  v1.get("/containers/:container/files", (c) => c.json(listOf([...containerOf(c).values()].map(containerFileWire))));
  v1.get("/containers/:container/files/:file", (c) => c.json(containerFileWire(containerFileOf(c))));
  v1.get("/containers/:container/files/:file/content", (c) => {
    const file = containerFileOf(c);
    c.header("content-type", file.mediaType);
    return c.body(file.bytes as Uint8Array<ArrayBuffer>);
  });

  const missing = (message: string) => new OpenAIError(404, { message, type: "invalid_request_error", param: null });
  /** A stored response, its call on record for the session it belongs to. */
  const storedOf = (c: Context) => {
    const id = c.req.param("id") ?? "";
    const stored = world.store.responses.get(id);
    if (!stored) throw missing(`Response with id '${id}' not found.`);
    belongsTo(c, stored.session);
    return stored;
  };
  /** A conversation, its call on record for the session it belongs to. */
  const conversationOf = (c: Context) => {
    const id = c.req.param("id") ?? "";
    const conversation = world.store.conversations.get(id);
    if (!conversation) throw missing(`Conversation with id '${id}' not found.`);
    belongsTo(c, conversation.session);
    return conversation;
  };

  v1.get("/responses/:id", (c) => c.json(storedOf(c).object));
  v1.delete("/responses/:id", (c) => {
    const { id } = storedOf(c);
    world.store.responses.delete(id);
    return c.json({ id, object: "response", deleted: true });
  });
  v1.get("/responses/:id/input_items", (c) => c.json(listOf([...storedOf(c).input].reverse())));

  // Conversations: their items are the history of the responses that name them.
  v1.post("/conversations", async (c) => {
    const parsed = await parse(c);
    const conversation = world.store.openConversation({
      id: ids.next(OPENAI_IDS.conversation),
      createdAt: Math.floor(clock() / 1000),
      metadata: isObject(parsed.metadata) ? (parsed.metadata as Record<string, string>) : {},
      items: inputItems(parsed.items).map((item) => withId(item)),
      session: undefined,
    });
    return c.json(conversationWire(conversation));
  });
  v1.get("/conversations/:id", (c) => c.json(conversationWire(conversationOf(c))));
  v1.post("/conversations/:id", async (c) => {
    const conversation = conversationOf(c);
    const parsed = await parse(c);
    if (isObject(parsed.metadata)) conversation.metadata = parsed.metadata as Record<string, string>;
    return c.json(conversationWire(conversation));
  });
  v1.delete("/conversations/:id", (c) => {
    const { id } = conversationOf(c);
    world.store.conversations.delete(id);
    return c.json({ id, object: "conversation.deleted", deleted: true });
  });
  v1.get("/conversations/:id/items", (c) => {
    const conversation = conversationOf(c);
    const order = c.req.query("order") === "asc" ? "asc" : "desc";
    return c.json(listOf(order === "asc" ? conversation.items : [...conversation.items].reverse()));
  });
  v1.post("/conversations/:id/items", async (c) => {
    const conversation = conversationOf(c);
    const parsed = await parse(c);
    const added = inputItems(parsed.items).map((item) => withId(item));
    conversation.items.push(...added);
    return c.json(listOf(added));
  });
  const itemOf = (c: Context) => {
    const conversation = world.store.conversations.get(c.req.param("id") ?? "");
    const at = conversation?.items.findIndex((candidate) => candidate.id === c.req.param("item")) ?? -1;
    if (!conversation || at === -1) throw missing(`Item with id '${c.req.param("item")}' not found.`);
    belongsTo(c, conversation.session);
    return { conversation, at };
  };
  v1.get("/conversations/:id/items/:item", (c) => {
    const { conversation, at } = itemOf(c);
    return c.json(conversation.items[at]);
  });
  v1.delete("/conversations/:id/items/:item", (c) => {
    const { conversation, at } = itemOf(c);
    conversation.items.splice(at, 1);
    return c.json(conversationWire(conversation));
  });

  v1.get("/models", (c) =>
    c.json({
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
    c.json({ id: c.req.param("model"), object: "model", created: MODEL_CREATED, owned_by: "system" }),
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
      throw new OpenAIError(404, { message: "Resource not found", type: "invalid_request_error", code: "404" });
    }
    return chat(c, c.req.param("deployment"));
  });
  api.all("*", (c) => {
    throw notFound(c.req.method, new URL(c.req.url).pathname);
  });

  // Every call on record for the session it belongs to (a model call when it ends); a call
  // without the key is refused and kept off it. Every answer carries OpenAI's headers.
  return wrapRest(
    context,
    {
      driver: "openai",
      refusal: (error) => (error instanceof OpenAIError ? refusalOf(error) : undefined),
      internal: () =>
        refusalOf(
          new OpenAIError(500, {
            message: "The server had an error while processing your request. Sorry about that!",
            type: "server_error",
          }),
        ),
      decorate: (answer, c) => {
        // Only a model call carries its session's rate limit; every other answer, the default one.
        const headers = common(
          c?.get(LIMITED as never) as string | undefined,
          (c?.get(STARTED as never) as number | undefined) ?? clock(),
        );
        // A refusal's own headers (the rate limit's, `retry-after`) stand.
        return {
          ...answer,
          headers: Object.fromEntries(Object.entries(headers).filter(([name]) => !c?.res.headers.has(name))),
        };
      },
    },
    api,
    { recorded: (c) => c.get(AUTHENTICATED as never) === true, sessions: (c) => [sessionOf(c)] },
  );
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

/** What a model call's record shows of its answer: the text, the tools called, how it finished. */
function summary(call: CallRecord) {
  return call.answer
    ? {
        text: call.answer.text,
        toolCalls: call.answer.toolCalls.map(({ name }) => name),
        finish: call.answer.finish,
      }
    : undefined;
}
