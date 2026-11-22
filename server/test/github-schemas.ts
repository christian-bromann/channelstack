import webhooks from "@octokit/openapi-webhooks/generated/api.github.com.json" with { type: "json" };
import rest from "@octokit/openapi/generated/api.github.com.json" with { type: "json" };
import { Ajv, type ValidateFunction } from "ajv";
import formats from "ajv-formats";

/**
 * GitHub's own descriptions of its REST API (`github/rest-api-description`) and its webhook
 * payloads (`octokit/openapi-webhooks`), as validators. Exit checks 3.2 and 3.3 hold every
 * response and every delivery of the fake to them.
 */
type Json = Record<string, unknown>;

// The package's default export is the function itself under Node's ESM; its types say otherwise.
const addFormats = formats as unknown as (ajv: Ajv) => void;

const pointer = (...parts: string[]) => parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");

function validators(id: string, document: unknown) {
  // The descriptions use OpenAPI keywords (`nullable`, `example`) that aren't JSON Schema's.
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  // GitHub's own bot addresses (`41898282+github-actions[bot]@users.noreply.github.com`) aren't
  // addresses by the strict rule, and GitHub sends them where its schemas say `format: email`.
  ajv.addFormat("email", /^[^\s@]+@[^\s@]+$/);
  ajv.addSchema(document as Json, id);
  const compiled = new Map<string, ValidateFunction | undefined>();
  return (path: string): ValidateFunction | undefined => {
    if (!compiled.has(path)) compiled.set(path, ajv.getSchema(`${id}#/${path}`));
    return compiled.get(path);
  };
}

/**
 * "This, or null" as JSON Schema says it. The REST description is OpenAPI 3.0, which writes
 * `nullable: true`; the webhook schemas were converted from that and write a nullable reference as
 * `allOf: [ref], type: ["null"]`, which no value satisfies as written.
 */
function withNull(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withNull);
  if (typeof node !== "object" || node === null) return node;
  const { nullable, ...schema } = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, withNull(value)]),
  );
  if (Array.isArray(schema.allOf) && Array.isArray(schema.type) && schema.type.join() === "null") {
    const { type: _type, ...rest } = schema;
    return { anyOf: [rest, { type: "null" }] };
  }
  if (nullable !== true) return schema;
  if (typeof schema.type !== "string") return { anyOf: [schema, { type: "null" }] };
  return {
    ...schema,
    type: [schema.type, "null"],
    ...(Array.isArray(schema.enum) && !schema.enum.includes(null) ? { enum: [...schema.enum, null] } : {}),
  };
}

/**
 * Where GitHub's REST description says something GitHub's own answers don't satisfy. Each entry
 * is read the way GitHub answers; decision 0013 lists them.
 */
function asGitHubAnswers(description: typeof rest): typeof rest {
  const fixed = structuredClone(description) as unknown as {
    components: { schemas: Record<string, { properties: Record<string, Json> }> };
    paths: Record<string, Record<string, { responses: Record<string, Json> }>>;
  };
  // An installation's account is a user or an enterprise. The description writes "both at once" (`allOf`).
  const account = fixed.components.schemas.installation?.properties.account;
  if (account) Object.assign(account, { anyOf: account.allOf, allOf: undefined });
  // A 409 from the contents API is a plain error, which also fits the rule-violation error (it has
  // no required fields), so "exactly one of the two" can never hold.
  for (const method of ["put", "delete"]) {
    const conflict = fixed.paths["/repos/{owner}/{repo}/contents/{path}"]?.[method]?.responses["409"] as
      { content?: Record<string, { schema: Json }> } | undefined;
    const schema = conflict?.content?.["application/json"]?.schema;
    if (schema) Object.assign(schema, { anyOf: schema.oneOf, oneOf: undefined });
  }
  return fixed as unknown as typeof rest;
}

/**
 * Answers GitHub gives that its description doesn't list for the route: the usual error object
 * for a validation failure or for something that isn't there.
 */
const UNLISTED: ReadonlyArray<readonly [method: string, template: string, status: number]> = [
  ["POST", "/repos/{owner}/{repo}/check-runs", 422],
  ["POST", "/repos/{owner}/{repo}/statuses/{sha}", 422],
  ["GET", "/app/hook/deliveries/{delivery_id}", 404],
  ["POST", "/app/hook/deliveries/{delivery_id}/attempts", 404],
  ["POST", "/app/installations/{installation_id}/access_tokens", 404],
];

const restSchema = validators("rest", withNull(asGitHubAnswers(rest)));
const webhookSchema = validators("webhooks", withNull(webhooks));

const problems = (validate: ValidateFunction, value: unknown): string[] =>
  validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);

/** Parameters that hold a path of their own: a file path, a ref like `heads/my-agent/fix`, a branch with a slash. */
const TAKES_THE_REST = new Set(["{path}", "{ref}", "{branch}", "{basehead}"]);

const templates = Object.keys(rest.paths).map((template) => {
  const segments = template.split("/");
  return {
    template,
    segments,
    rest: TAKES_THE_REST.has(segments.at(-1) ?? ""),
    literals: segments.filter((segment) => !segment.startsWith("{")).length,
  };
});

/** The path template of GitHub's description that a request path matches: the one with the most literal segments. */
function restTemplate(path: string): string | undefined {
  // GitHub Enterprise serves the same API under `/api/v3`.
  const segments = path.replace(/^\/api\/v3(?=\/)/, "").split("/");
  return (
    templates
      .filter(
        (candidate) =>
          (candidate.segments.length === segments.length ||
            (candidate.rest && candidate.segments.length < segments.length)) &&
          candidate.segments.every((segment, index) => segment.startsWith("{") || segment === segments[index]),
      )
      // The closest description wins: the most literal segments, then the one that needs no "rest of the path".
      .sort((a, b) => b.literals - a.literals || Number(a.rest) - Number(b.rest))[0]?.template
  );
}

/**
 * What is wrong with a response, by GitHub's description: nothing (`[]`), or one line per
 * problem. A path, method or status GitHub doesn't describe is a problem too.
 */
export function restProblems(method: string, path: string, status: number, body: unknown): string[] {
  const template = restTemplate(path);
  if (template === undefined) return [`GitHub's REST description has no path like ${path}`];
  const operation = (rest.paths as Json)[template] as Record<string, { responses?: Record<string, Json> }>;
  const responses = operation[method.toLowerCase()]?.responses;
  if (!responses) return [`GitHub's REST description has no ${method} ${template}`];
  if (UNLISTED.some(([verb, route, code]) => verb === method && route === template && code === status)) {
    const { message } = (body ?? {}) as { message?: unknown };
    return typeof message === "string" ? [] : [`${method} ${template} ${status}: an error needs a message`];
  }
  const described = responses[String(status)];
  if (!described)
    return [`${method} ${template} doesn't answer ${status} (it answers ${Object.keys(responses).join(", ")})`];
  // A response is described in place, or by reference to a shared one (`#/components/responses/not_found`).
  const shared = typeof described.$ref === "string" ? described.$ref.slice(2) : undefined;
  const response = shared
    ? (shared.split("/").reduce<unknown>((at, key) => (at as Json)[key], rest) as Json)
    : described;
  // Where the description gives no body there is nothing to hold one to (GitHub still sends its usual error object).
  if (!("content" in response)) return [];
  const validate = restSchema(
    `${shared ?? pointer("paths", template, method.toLowerCase(), "responses", String(status))}/${pointer("content", "application/json", "schema")}`,
  );
  if (!validate) return [`${method} ${template} ${status} has no JSON schema`];
  return problems(validate, body).map((problem) => `${method} ${template} ${status}: ${problem}`);
}

/** What is wrong with a webhook payload, by GitHub's schemas: `[]` when nothing is. */
export function webhookProblems(event: string, payload: unknown): string[] {
  const action = (payload as { action?: unknown }).action;
  const name = [event, ...(typeof action === "string" ? [action] : [])].join("-").replaceAll("_", "-");
  const validate = webhookSchema(
    pointer("webhooks", name, "post", "requestBody", "content", "application/json", "schema"),
  );
  if (!validate) return [`GitHub's webhook schemas have no ${name}`];
  return problems(validate, payload).map((problem) => `${name}: ${problem}`);
}
