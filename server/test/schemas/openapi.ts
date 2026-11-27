import formats from "ajv-formats";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * A platform's OpenAPI 3.1 description as checks: what it says about one answer of the API, and
 * about any schema in it by its JSON pointer (a webhook's, a Gateway object's). Its schemas are
 * JSON Schema 2020-12. Resend's and Discord's checks are built on it.
 */
type Json = Record<string, unknown>;

// The package's default export is the function itself under Node's ESM; its types say otherwise.
const addFormats = formats as unknown as (ajv: Ajv2020) => void;

const pointerPart = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1");

/** The value a JSON pointer's parts name in a document. */
const resolvePointer = (document: unknown, parts: readonly string[]): unknown =>
  parts.reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], document);

export interface OpenApiChecks {
  /** What the description says about one answer: nothing when it fits, or when it lists no body for it. */
  response(method: string, path: string, status: number, body: unknown): string[];
  /** What the schema at this pointer (`["components", "schemas", "MessageResponse"]`) says about a value. */
  schema(pointer: readonly string[], value: unknown, where: string): string[];
}

export function openApiChecks(
  description: Json,
  options: {
    /** The platform's name, for the messages: "Resend's description has no schema for it". */
    name: string;
    /** What the API's paths have before the description's templates (`/api/v10`), taken off first. */
    prefix?: RegExp;
    /** Hold error answers to the status's schema too, for a description that has one for them (Discord's). */
    errors?: boolean;
  },
): OpenApiChecks {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(description, "description");
  const compiled = new Map<string, ValidateFunction | undefined>();
  const schemaAt = (pointer: readonly string[]) => {
    const key = pointer.map(pointerPart).join("/");
    if (!compiled.has(key)) compiled.set(key, ajv.getSchema(`description#/${key}`));
    return compiled.get(key);
  };
  const paths = description.paths as Record<string, Record<string, { responses?: Record<string, Json> }>>;
  /** Each path template as a pattern: `/emails/{email_id}` matches `/emails/4ef9…`. */
  const templates = Object.keys(paths).map((template) => ({
    template,
    pattern: new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+")}$`),
    // A literal path wins over a template that would match it too (`/emails/receiving` over `/emails/{id}`).
    literal: template.split("{").length,
  }));
  const problemsOf = (validate: ValidateFunction | undefined, value: unknown, where: string): string[] => {
    if (!validate) return [`${where}: ${options.name}'s description has no schema for it`];
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
  };

  return {
    response(method, rawPath, status, body) {
      const bare = rawPath.split("?")[0] ?? rawPath;
      const path = options.prefix ? bare.replace(options.prefix, "") : bare;
      const match = templates.filter(({ pattern }) => pattern.test(path)).sort((a, b) => a.literal - b.literal)[0];
      if (!match) return [`${method} ${path}: not in ${options.name}'s description`];
      const operation = paths[match.template]?.[method.toLowerCase()];
      if (!operation)
        return [`${method} ${path}: ${options.name}'s description has no ${method} for ${match.template}`];
      // The status's own answer, or its class's (`4XX`); a `$ref` to the description's shared answers is followed.
      const key = [String(status), `${String(status)[0]}XX`].find((candidate) => operation.responses?.[candidate]);
      // An answer the description lists without a body, or an error where errors aren't held, has nothing to hold it to.
      if (key === undefined || (status >= 400 && !options.errors)) return [];
      const entry = operation.responses?.[key] as { $ref?: string; content?: Record<string, unknown> };
      const at = entry.$ref
        ? entry.$ref
            .replace(/^#\//, "")
            .split("/")
            .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
        : ["paths", match.template, method.toLowerCase(), "responses", key];
      const answer = entry.$ref ? resolvePointer(description, at) : entry;
      if ((answer as { content?: Record<string, unknown> } | undefined)?.content?.["application/json"] === undefined)
        return [];
      const pointer = [...at, "content", "application/json", "schema"];
      return problemsOf(schemaAt(pointer), body, `${method} ${path} ${status}`);
    },
    schema: (pointer, value, where) => problemsOf(schemaAt(pointer), value, where),
  };
}
