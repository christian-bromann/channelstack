import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import formats from "ajv-formats";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * OpenAI's own description of its API (`openai/openai-openapi`, pinned gzipped by
 * `scripts/pinned-schema.ts`), as validators. Exit check 13.2 holds every answer and every stream
 * event of the fake to them. The description is OpenAPI 3.1, so its schemas are JSON Schema 2020-12.
 */
type Json = Record<string, unknown>;

const addFormats = formats as unknown as (ajv: Ajv2020) => void;

const description = JSON.parse(
  gunzipSync(readFileSync(new URL("./openai-openapi.json.gz", import.meta.url))).toString("utf8"),
) as Json;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(description, "openai");
const compiled = new Map<string, ValidateFunction | undefined>();
const schema = (name: string) => {
  if (!compiled.has(name)) compiled.set(name, ajv.getSchema(`openai#/components/schemas/${name}`));
  return compiled.get(name);
};

const problemsOf = (name: string, value: unknown, where: string): string[] => {
  const validate = schema(name);
  if (!validate) return [`${where}: OpenAI's description has no schema ${name}`];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 5).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
};

/** Held to any of several schemas, as OpenAI describes an answer whose shape its format decides (a transcript's). */
const problemsOfAny = (names: readonly string[], value: unknown, where: string): string[] => {
  const found = names.map((name) => problemsOf(name, value, where));
  return found.some((problems) => problems.length === 0) ? [] : (found[0] ?? []);
};

/** The schemas an answer of this path is held to, by its method and path; none for one with no JSON body to check. */
function answerSchema(method: string, path: string): string | readonly string[] | undefined {
  const route = `${method.toUpperCase()} ${path.replace(/^\/openai(?=\/)/, "").replace(/^\/openai\/v1|^\/v1/, "")}`;
  if (route === "POST /chat/completions" || /^POST \/openai\/deployments\/[^/]+\/chat\/completions$/.test(route)) {
    return "CreateChatCompletionResponse";
  }
  if (route === "POST /responses" || /^GET \/responses\/[^/]+$/.test(route)) return "Response";
  if (/^GET \/responses\/[^/]+\/input_items$/.test(route)) return "ResponseItemList";
  if (route === "POST /conversations" || /^(GET|POST) \/conversations\/[^/]+$/.test(route))
    return "ConversationResource";
  if (/^DELETE \/conversations\/[^/]+$/.test(route)) return "DeletedConversationResource";
  if (/^GET \/conversations\/[^/]+\/items$/.test(route)) return "ConversationItemList";
  if (route === "GET /models") return "ListModelsResponse";
  if (route === "POST /images/generations" || route === "POST /images/edits") return "ImagesResponse";
  if (route === "POST /audio/transcriptions") {
    return [
      "CreateTranscriptionResponseJson",
      "CreateTranscriptionResponseVerboseJson",
      "CreateTranscriptionResponseDiarizedJson",
    ];
  }
  if (route === "POST /audio/translations")
    return ["CreateTranslationResponseJson", "CreateTranslationResponseVerboseJson"];
  if (route === "POST /files" || /^GET \/files\/[^/]+$/.test(route)) return "OpenAIFile";
  if (route === "GET /files") return "ListFilesResponse";
  if (/^DELETE \/files\/[^/]+$/.test(route)) return "DeleteFileResponse";
  if (/^GET \/containers\/[^/]+\/files$/.test(route)) return "ContainerFileListResource";
  if (/^GET \/containers\/[^/]+\/files\/[^/]+$/.test(route)) return "ContainerFileResource";
  return undefined;
}

/** What OpenAI's description says about one answer: nothing when it fits. Errors are held to `ErrorResponse`. */
export function openaiResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  const where = `${method} ${path} ${status}`;
  if (status >= 400) return problemsOf("ErrorResponse", body, where);
  const name = answerSchema(method, path);
  if (name === undefined) return [];
  return typeof name === "string" ? problemsOf(name, body, where) : problemsOfAny(name, body, where);
}

/** What it says about one event of a stream: a Chat Completions chunk, or a Responses event. */
export function openaiStreamProblems(path: string, event: Json): string[] {
  if ("error" in event && !("type" in event)) return problemsOf("ErrorResponse", event, `${path} stream`);
  if (/chat\/completions$/.test(path)) return problemsOf("CreateChatCompletionStreamResponse", event, `${path} chunk`);
  if (/audio\/transcriptions$/.test(path))
    return problemsOf("CreateTranscriptionResponseStreamEvent", event, `${path} ${String(event.type)}`);
  if (/audio\/speech$/.test(path))
    return problemsOf("CreateSpeechResponseStreamEvent", event, `${path} ${String(event.type)}`);
  return problemsOf("ResponseStreamEvent", event, `${path} ${String(event.type)}`);
}
