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

/** The schema an answer of this path is held to, by its method and path; none for one with no body to check. */
function answerSchema(method: string, path: string): string | undefined {
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
  return undefined;
}

/** What OpenAI's description says about one answer: nothing when it fits. Errors are held to `ErrorResponse`. */
export function openaiResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  const where = `${method} ${path} ${status}`;
  if (status >= 400) return problemsOf("ErrorResponse", body, where);
  const name = answerSchema(method, path);
  return name === undefined ? [] : problemsOf(name, body, where);
}

/** What it says about one event of a stream: a Chat Completions chunk, or a Responses event. */
export function openaiStreamProblems(path: string, event: Json): string[] {
  if ("error" in event && !("type" in event)) return problemsOf("ErrorResponse", event, `${path} stream`);
  if (/chat\/completions$/.test(path)) return problemsOf("CreateChatCompletionStreamResponse", event, `${path} chunk`);
  return problemsOf("ResponseStreamEvent", event, `${path} ${String(event.type)}`);
}
