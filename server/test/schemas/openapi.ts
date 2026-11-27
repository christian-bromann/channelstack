import type { Ajv } from "ajv";
import type { Ajv2020, ValidateFunction } from "ajv/dist/2020.js";

/**
 * A platform's OpenAPI description as checks, written once for each one pinned (Resend's, Twilio's):
 * its schemas compiled by pointer, and what it says about one answer of the API. `ajv` has the
 * description added under `id` already, with the formats it uses.
 */
type Json = Record<string, unknown>;

export function openApiChecks(
  ajv: Ajv | Ajv2020,
  id: string,
  description: { paths: unknown },
  platform: string,
  options: {
    /** An answer with a status the description doesn't list is a problem too (Twilio's lists every one). */
    strictStatus?: boolean;
  } = {},
) {
  const compiled = new Map<string, ValidateFunction | undefined>();
  const schemaAt = (pointer: string) => {
    if (!compiled.has(pointer))
      compiled.set(pointer, ajv.getSchema(`${id}#/${pointer}`) as ValidateFunction | undefined);
    return compiled.get(pointer);
  };
  const pointerPart = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1");
  const paths = description.paths as Record<string, Record<string, { responses?: Record<string, Json> }>>;
  /** Each path template as a pattern: `/emails/{email_id}` matches `/emails/4ef9…`. */
  const templates = Object.keys(paths).map((template) => ({
    template,
    pattern: new RegExp(`^${template.replace(/\./g, "\\.").replace(/\{[^}]+\}/g, "[^/]+")}$`),
    // A literal path wins over a template that would match it too (`/emails/receiving` over `/emails/{id}`).
    literal: template.split("{").length,
  }));

  /** What a schema says about a value: nothing when it fits. */
  const problemsOf = (validate: ValidateFunction | undefined, value: unknown, where: string): string[] => {
    if (!validate) return [`${where}: ${platform}'s description has no schema for it`];
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
  };

  /** What the description says about one answer of the API: nothing when it fits. */
  const responseProblems = (method: string, path: string, status: number, body: unknown): string[] => {
    const match = templates.filter(({ pattern }) => pattern.test(path)).sort((a, b) => a.literal - b.literal)[0];
    if (!match) return [`${method} ${path}: not in ${platform}'s description`];
    const operation = paths[match.template]?.[method.toLowerCase()];
    if (!operation) return [`${method} ${path}: ${platform}'s description has no ${method} for ${match.template}`];
    const response = operation.responses?.[String(status)] as { content?: Record<string, unknown> } | undefined;
    // A refusal, or an answer the description lists without a body (a 204), has nothing to hold it to.
    if (status >= 400) return [];
    if (!response && options.strictStatus)
      return [`${method} ${path}: ${platform}'s description has no ${status} answer`];
    if (response?.content?.["application/json"] === undefined) return [];
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
  };

  return { schemaAt, pointerPart, problemsOf, responseProblems };
}
