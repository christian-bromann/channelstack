import formats from "ajv-formats";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import description from "./resend-openapi.json" with { type: "json" };

/**
 * Resend's own description of its REST API and webhooks (`resend/resend-openapi`, pinned by
 * `scripts/resend-schema.ts`), as validators. Exit check 8.3 holds every answer and every webhook
 * of the fake to them. The description is OpenAPI 3.1, so its schemas are JSON Schema 2020-12.
 */
type Json = Record<string, unknown>;

// The package's default export is the function itself under Node's ESM; its types say otherwise.
const addFormats = formats as unknown as (ajv: Ajv2020) => void;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(description as Json, "resend");
const compiled = new Map<string, ValidateFunction | undefined>();
const schemaAt = (pointer: string) => {
  if (!compiled.has(pointer)) compiled.set(pointer, ajv.getSchema(`resend#/${pointer}`));
  return compiled.get(pointer);
};
const pointerPart = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1");

const paths = description.paths as Record<string, Record<string, { responses?: Record<string, Json> }>>;
/** Each path template as a pattern: `/emails/{email_id}` matches `/emails/4ef9…`. */
const templates = Object.keys(paths).map((template) => ({
  template,
  pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
  // A literal path wins over a template that would match it too (`/emails/receiving` over `/emails/{id}`).
  literal: template.split("{").length,
}));

const problemsOf = (validate: ValidateFunction | undefined, value: unknown, where: string): string[] => {
  if (!validate) return [`${where}: Resend's description has no schema for it`];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
};

/** What Resend's description says about one answer of the API: nothing when it fits. */
export function resendResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  const match = templates.filter(({ pattern }) => pattern.test(path)).sort((a, b) => a.literal - b.literal)[0];
  if (!match) return [`${method} ${path}: not in Resend's description`];
  const operation = paths[match.template]?.[method.toLowerCase()];
  if (!operation) return [`${method} ${path}: Resend's description has no ${method} for ${match.template}`];
  const content = operation.responses?.[String(status)] as { content?: Record<string, unknown> } | undefined;
  // An error answer, or one the description lists without a body, has nothing to hold it to.
  if (status >= 400 || content?.content?.["application/json"] === undefined) return [];
  const pointer = [
    "paths",
    match.template,
    method.toLowerCase(),
    "responses",
    String(status),
    "content",
    "application/json",
    "schema",
  ]
    .map(pointerPart)
    .join("/");
  return problemsOf(schemaAt(pointer), body, `${method} ${path} ${status}`);
}

/** What it says about one webhook. */
export function resendWebhookProblems(type: string, payload: unknown): string[] {
  const pointer = ["webhooks", type, "post", "requestBody", "content", "application/json", "schema"]
    .map(pointerPart)
    .join("/");
  return problemsOf(schemaAt(pointer), payload, `webhook ${type}`);
}
