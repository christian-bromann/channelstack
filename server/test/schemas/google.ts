import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import discovery from "./gmail-discovery.json" with { type: "json" };

/**
 * Gmail's own description of its API (its discovery document, pinned by `scripts/pinned-schema.ts`)
 * as validators, and Pub/Sub's push format as its documentation gives it. Exit check 9.2 holds
 * every answer and every push of the fake to them.
 *
 * A discovery document's schemas are almost JSON Schema: a `$ref` names a schema, 64-bit numbers
 * are strings, and nothing says which properties a resource may not have. As validators here, a
 * `$ref` points into `$defs`, `int64` and `uint64` are decimal strings, and a resource may have
 * only the properties the document lists: the fake must not send what Gmail doesn't.
 */
type Json = Record<string, unknown>;
type DiscoverySchema = {
  type?: string;
  format?: string;
  $ref?: string;
  items?: DiscoverySchema;
  properties?: Record<string, DiscoverySchema>;
  additionalProperties?: DiscoverySchema;
  enum?: string[];
};

/** One discovery schema as JSON Schema. */
function converted(schema: DiscoverySchema): Json {
  if (schema.$ref) return { $ref: `#/$defs/${schema.$ref}` };
  switch (schema.type) {
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([name, property]) => [name, converted(property)]),
        ),
        additionalProperties: schema.additionalProperties ? converted(schema.additionalProperties) : false,
      };
    case "array":
      return { type: "array", items: converted(schema.items ?? {}) };
    case "string":
      if (schema.format === "int64" || schema.format === "uint64") return { type: "string", pattern: "^-?\\d+$" };
      if (schema.format === "byte") return { type: "string", pattern: "^[A-Za-z0-9_=+/-]*$" };
      return schema.enum ? { type: "string", enum: schema.enum } : { type: "string" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    default:
      return {};
  }
}

const schemas = discovery.schemas as unknown as Record<string, DiscoverySchema>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(
  {
    $id: "gmail",
    $defs: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, converted(schema)])),
  },
  "gmail",
);
const compiled = new Map<string, ValidateFunction | undefined>();
const schemaOf = (name: string) => {
  if (!compiled.has(name)) compiled.set(name, ajv.getSchema(`gmail#/$defs/${name}`));
  return compiled.get(name);
};

/** Every method the document has, by HTTP method and path pattern, with the schema it answers. */
interface Method {
  readonly httpMethod: string;
  readonly path: string;
  readonly response?: { $ref: string };
}
const methods: Array<Method & { pattern: RegExp; literal: number }> = [];
const collect = (resource: { methods?: Record<string, Method>; resources?: Record<string, unknown> }) => {
  for (const method of Object.values(resource.methods ?? {})) {
    methods.push({
      ...method,
      pattern: new RegExp(`^/${method.path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
      literal: method.path.split("{").length,
    });
  }
  for (const child of Object.values(resource.resources ?? {})) collect(child as Parameters<typeof collect>[0]);
};
collect(discovery as unknown as Parameters<typeof collect>[0]);

/** Google's error envelope, which every Google API answers a refusal with. */
const errorEnvelope = ajv.compile({
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "errors", "status"],
      additionalProperties: false,
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
        status: { type: "string", pattern: "^[A-Z_]+$" },
        errors: {
          type: "array",
          items: {
            type: "object",
            required: ["message", "domain", "reason"],
            properties: { message: { type: "string" }, domain: { type: "string" }, reason: { type: "string" } },
          },
        },
        details: { type: "array" },
      },
    },
  },
});

const problemsOf = (validate: ValidateFunction | undefined, value: unknown, where: string): string[] => {
  if (!validate) return [`${where}: Gmail's discovery document has no schema for it`];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
};

/**
 * What Gmail's discovery document says about one answer of the API: nothing when it fits. Google's
 * token endpoint and certificates aren't Gmail's, and have no document to hold them to.
 */
export function googleResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  if (!path.startsWith("/gmail/")) return [];
  const where = `${method} ${path} ${status}`;
  if (status >= 400) return problemsOf(errorEnvelope, body, where);
  const match = methods
    .filter((each) => each.httpMethod === method.toUpperCase() && each.pattern.test(path))
    .sort((a, b) => a.literal - b.literal)[0];
  if (!match) return [`${method} ${path}: not in Gmail's discovery document`];
  // A method the document gives no response (`users.stop`) answers nothing.
  if (!match.response) return status === 204 && body === undefined ? [] : [`${where}: Gmail answers it with no body`];
  return problemsOf(schemaOf(match.response.$ref), body, where);
}

/** Pub/Sub's push, in its wrapped format, carrying Gmail's notification. */
const push = ajv.compile({
  type: "object",
  required: ["message", "subscription"],
  additionalProperties: false,
  properties: {
    message: {
      type: "object",
      required: ["data", "messageId", "message_id", "publishTime", "publish_time"],
      additionalProperties: false,
      properties: {
        data: { type: "string", pattern: "^[A-Za-z0-9+/]*={0,2}$" },
        messageId: { type: "string", pattern: "^\\d+$" },
        message_id: { type: "string", pattern: "^\\d+$" },
        publishTime: { type: "string", format: "date-time" },
        publish_time: { type: "string", format: "date-time" },
        attributes: { type: "object", additionalProperties: { type: "string" } },
        orderingKey: { type: "string" },
      },
    },
    subscription: { type: "string", pattern: "^projects/[^/]+/subscriptions/[^/]+$" },
    deliveryAttempt: { type: "integer" },
  },
});
const notification = ajv.compile({
  type: "object",
  required: ["emailAddress", "historyId"],
  additionalProperties: false,
  properties: { emailAddress: { type: "string" }, historyId: { type: "string", pattern: "^\\d+$" } },
});

/** What Pub/Sub's push format and Gmail's notification say about one push. */
export function googlePushProblems(body: unknown): string[] {
  const problems = problemsOf(push, body, "push");
  if (problems.length > 0) return problems;
  const message = (body as { message: { data: string; messageId: string; message_id: string } }).message;
  if (message.messageId !== message.message_id) problems.push("push: messageId and message_id differ");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
  } catch {
    return [...problems, "push: message.data isn't base64 JSON"];
  }
  return [...problems, ...problemsOf(notification, decoded, "push data")];
}
