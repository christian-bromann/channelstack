/**
 * The IR: a language-neutral description of the SDK surface. It is built from the OpenAPI
 * document and its `x-channelstack-*` extensions; emitters read only the IR.
 */
export interface Ir {
  /** The server version this surface belongs to. SDKs check its major version on connect. */
  version: string;
  /** Path prefix of the control API on the server. */
  basePath: string;
  /** The resource a client starts from. It has no id and no session. */
  root: string;
  resources: IrResource[];
  types: IrNamedType[];
  /** Every error code an operation can return. */
  errors: string[];
}

/** A handle: an object with an identity on the server, and methods. */
export interface IrResource {
  name: string;
  /**
   * The fields that identify the handle: one for most (`id`), several where the platform needs
   * them (a Slack message is `channel` and `ts`). Fixtures and the root have none.
   */
  idFields?: string[];
  /** This resource is the session: its id is the `{session}` of everything created through it. */
  scope?: "session";
  /**
   * The resource this one is a kind of: a pull request is an issue. It has every field and method
   * of its parent (its own `fields` list them too), and goes wherever the parent is accepted.
   */
  extends?: string;
  fields: IrField[];
  methods: IrMethod[];
  /** Waits built on this handle's list reads: `thread.waitForReply()`. */
  waits?: IrWait[];
}

export interface IrWait {
  name: string;
  /** `next`: the first new matching item since the handle last looked. `latest`: the last matching item once the agent is quiet. */
  /** `until`: the read's value, once `field` is no longer one of `not`. */
  mode: "next" | "latest" | "until";
  /** The read to poll: a list for `next` and `latest`, one value for `until`. */
  read: string;
  /** The type the wait resolves with: one item of the list, or the value itself. */
  item: IrType;
  field?: string;
  not?: string[];
  /** For `until`: the wait takes the value, or the values, to wait for as its first argument. */
  in?: true;
  /** For `next`: an item whose `field` is `value` starts a new turn; the wait looks only after the newest one. */
  turn?: { field: string; value: string };
  /** The item field holding its author, which the `from` option filters on. */
  from?: string;
  /** A text field of the item; an option of the same name narrows the wait by a string or a pattern. */
  text?: string;
  /** The wait's first argument is the read's own options, passed through to it. */
  filter?: true;
  /** What is waited for, for the timeout message. */
  what: string;
}

/** A named data type: plain values with no identity. */
interface IrNamedType {
  name: string;
  type: IrType;
  /** The field that is this value as text: what `toString()` (or `__str__`) returns. */
  stringField?: string;
}

export interface IrField {
  name: string;
  type: IrType;
  optional: boolean;
}

export type IrType =
  | { kind: "string" | "number" | "integer" | "boolean" | "unknown" }
  /** A length of time. SDKs take `"3s"` or milliseconds and send milliseconds. */
  | { kind: "duration" }
  | { kind: "literal"; value: string | boolean }
  | { kind: "enum"; values: string[] }
  /** `oneOrMany`: as an argument, a single item is accepted in place of a list of one. */
  | { kind: "array"; items: IrType; oneOrMany?: true }
  | { kind: "record"; values: IrType }
  /** `shorthand`: as an argument, the value of that one field stands for the whole object (`[ana]` for `[{ user: ana }]`). */
  | { kind: "object"; fields: IrField[]; shorthand?: string }
  /**
   * Files a test hands over. SDKs take a directory, files on disk or inline contents and send
   * paths with base64 contents: a whole tree (`tree`), or changes where `null` deletes (`changes`).
   * `document` is one text: inline, or a fixture file's contents (`{ path }`), sent as the text;
   * anything else (structured content) is sent as it is.
   */
  | { kind: "files"; mode: "tree" | "changes" | "document" }
  /** Text to find: a string, or a pattern (a `RegExp`), sent as `{ source, flags }`. */
  | { kind: "pattern" }
  /** A named data type from `types`. */
  | { kind: "named"; name: string }
  /** In a response: the wire data of a handle, which SDKs wrap into the handle again. */
  | { kind: "resource"; name: string }
  /** In a request: a handle, sent by its id (an object of its id fields when it has several). */
  | { kind: "ref"; resources: string[] }
  /** A value that may be absent (JSON `null`): SDKs give the language's "nothing" for it. */
  | { kind: "nullable"; type: IrType }
  /** One of several types. `discriminator` names the literal field that tells them apart. */
  | { kind: "union"; types: IrType[]; discriminator?: string };

export interface IrParam extends IrField {
  in: "body" | "query";
  /** For an object argument: a plain string is shorthand for `{ [shorthand]: string }` (`ana.say("hi", …)`). */
  shorthand?: string;
  /**
   * A credential the caller may leave out: SDKs then read it from the environment variable this
   * template names, with `{field}` replaced by that field's value in `NAME` form
   * (`CHANNELSTACK_SLACK_USER_{name}_TOKEN`, Ana → `CHANNELSTACK_SLACK_USER_ANA_TOKEN`).
   */
  credential?: string;
}

interface IrPathParam {
  name: string;
  /** Bound to the session the handle lives in, or to a field of the handle itself. */
  from: "session" | "self";
  field?: string;
}

export interface IrMethod {
  name: string;
  /** A factory creates a handle; a method acts on or reads one. */
  kind: "factory" | "method";
  summary: string;
  stability: "experimental" | "stable";
  http: { verb: "GET" | "POST" | "DELETE"; path: string; pathParams: IrPathParam[] };
  /** Positional parameters. */
  args: IrParam[];
  /** The trailing options object. */
  options: IrParam[];
  returns: IrType | null;
  errors: string[];
  /** Ends the handle's life: SDKs call it on dispose. */
  dispose: boolean;
  /** Repeat the call while it is refused with one of these codes, up to the wait timeout. */
  retryWhile?: string[];
  /** Wait until the agent is quiet before reading. */
  onceQuiet?: true;
}

// ---------------------------------------------------------------------------------------------
// OpenAPI → IR
// ---------------------------------------------------------------------------------------------

type Json = Record<string, any>;

const ROOT = "Channelstack";
const REF_PREFIX = "#/components/schemas/";

class SpecError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = "SpecError";
  }
}

export function buildIr(openapi: Json): Ir {
  const schemas: Json = openapi.components?.schemas ?? {};
  const resourceNames = new Set([
    ROOT,
    ...Object.keys(schemas).filter((name) => schemas[name]["x-channelstack-resource"]),
  ]);

  const refName = (schema: Json): string | undefined =>
    typeof schema.$ref === "string" && schema.$ref.startsWith(REF_PREFIX)
      ? schema.$ref.slice(REF_PREFIX.length)
      : undefined;

  const typeOf = (schema: Json, where: string): IrType => {
    const named = refName(schema);
    if (named !== undefined) {
      if (!(named in schemas)) throw new SpecError(where, `unknown schema "${named}"`);
      return resourceNames.has(named) ? { kind: "resource", name: named } : { kind: "named", name: named };
    }
    const refs: unknown = schema["x-channelstack-ref"];
    if (Array.isArray(refs)) {
      for (const name of refs)
        if (!resourceNames.has(name)) throw new SpecError(where, `x-channelstack-ref names unknown resource "${name}"`);
      return { kind: "ref", resources: refs };
    }
    // "This, or null", the way OpenAPI 3.1 writes a nullable reference: the reference, and a type list with "null".
    if (Array.isArray(schema.allOf) && schema.allOf.length === 2) {
      const [target, nullability] = schema.allOf as Json[];
      if (
        refName(target ?? {}) !== undefined &&
        Array.isArray(nullability?.type) &&
        nullability.type.includes("null")
      ) {
        return { kind: "nullable", type: typeOf(target ?? {}, where) };
      }
    }
    // Kinds the SDKs build from more than one shape: before the alternatives are read as a union.
    if (schema["x-channelstack-pattern"] === true) return { kind: "pattern" };
    if (schema["x-channelstack-files"] === "document") return { kind: "files", mode: "document" };
    const alternatives: Json[] | undefined = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(alternatives)) {
      // "One of these, or null": the alternatives that aren't null, marked as nullable.
      const present = alternatives.filter((alternative) => alternative.type !== "null");
      if (present.length < alternatives.length) {
        const [only] = present;
        return {
          kind: "nullable",
          type: present.length === 1 && only ? typeOf(only, where) : typeOf({ anyOf: present }, where),
        };
      }
      const types = alternatives.map((alternative, index) => typeOf(alternative, `${where}|${index}`));
      const discriminator: unknown = schema.discriminator?.propertyName;
      return { kind: "union", types, ...(typeof discriminator === "string" ? { discriminator } : {}) };
    }
    if (schema["x-channelstack-duration"] === true) return { kind: "duration" };
    const files: unknown = schema["x-channelstack-files"];
    if (files === "tree" || files === "changes") return { kind: "files", mode: files };
    if (typeof schema.const === "string") return { kind: "literal", value: schema.const };
    if (Array.isArray(schema.enum)) {
      const [first] = schema.enum;
      return schema.enum.length === 1 && (typeof first === "string" || typeof first === "boolean")
        ? { kind: "literal", value: first }
        : { kind: "enum", values: schema.enum.map(String) };
    }
    // "A string, or null", the way OpenAPI 3.1 writes a nullable value: a type list with "null".
    if (Array.isArray(schema.type) && schema.type.length === 2 && schema.type.includes("null")) {
      const [present] = schema.type.filter((name: string) => name !== "null");
      return { kind: "nullable", type: typeOf({ ...schema, type: present }, where) };
    }
    switch (schema.type) {
      case "string":
      case "number":
      case "integer":
      case "boolean":
        return { kind: schema.type };
      case "array":
        return {
          kind: "array",
          items: typeOf(schema.items ?? {}, `${where}[]`),
          ...(schema["x-channelstack-one-or-many"] === true ? { oneOrMany: true as const } : {}),
        };
      case "object": {
        if (schema.properties) {
          const fields = fieldsOf(schema, where);
          const shorthand: unknown = schema["x-channelstack-shorthand"];
          if (typeof shorthand !== "string") return { kind: "object", fields };
          if (!fields.some((field) => field.name === shorthand)) {
            throw new SpecError(where, `x-channelstack-shorthand names "${shorthand}", which the object doesn't have`);
          }
          return { kind: "object", fields, shorthand };
        }
        const values = schema.additionalProperties;
        return {
          kind: "record",
          values: typeof values === "object" ? typeOf(values, `${where}{}`) : { kind: "unknown" },
        };
      }
      case undefined:
        if (Object.keys(schema).every((key) => key === "description" || key === "example")) return { kind: "unknown" };
    }
    throw new SpecError(where, `unsupported schema ${JSON.stringify(schema)}`);
  };

  const fieldsOf = (schema: Json, where: string): IrField[] => {
    const required = new Set<string>(schema.required ?? []);
    return Object.entries<Json>(schema.properties ?? {}).map(([name, property]) => ({
      name,
      type: typeOf(property, `${where}.${name}`),
      // A field with a default is optional for the caller; the server fills it in.
      optional: !required.has(name) || property.default !== undefined,
    }));
  };

  const resources = new Map<string, IrResource>([[ROOT, { name: ROOT, fields: [], methods: [] }]]);
  const types: IrNamedType[] = [];
  for (const [name, schema] of Object.entries<Json>(schemas)) {
    const marker: Json | undefined = schema["x-channelstack-resource"];
    if (!marker) {
      const stringField: unknown = schema["x-channelstack-string"];
      types.push({ name, type: typeOf(schema, name), ...(typeof stringField === "string" ? { stringField } : {}) });
      continue;
    }
    const fields = fieldsOf(schema, name);
    const idFields: string[] | undefined = marker.id === undefined ? undefined : [marker.id].flat();
    for (const id of idFields ?? []) {
      if (!fields.some((field) => field.name === id)) {
        throw new SpecError(name, `x-channelstack-resource names id field "${id}", which the schema doesn't have`);
      }
    }
    resources.set(name, {
      name,
      ...(idFields === undefined ? {} : { idFields }),
      ...(marker.scope === undefined ? {} : { scope: marker.scope }),
      ...(typeof marker.extends === "string" ? { extends: marker.extends } : {}),
      fields,
      methods: [],
    });
  }
  for (const resource of resources.values()) {
    if (resource.extends === undefined) continue;
    const parent = resources.get(resource.extends);
    if (!parent) throw new SpecError(resource.name, `extends unknown resource "${resource.extends}"`);
    const missing = parent.fields.filter((field) => !resource.fields.some((own) => own.name === field.name));
    if (missing.length > 0 || parent.idFields?.join() !== resource.idFields?.join()) {
      throw new SpecError(
        resource.name,
        `extends ${parent.name}, so it needs the same id and every field of it (missing: ${missing.map((field) => field.name).join(", ") || "none"})`,
      );
    }
  }

  /** The item type of a list read: an array, or a named alias of one. */
  const itemOf = (type: IrType | null, where: string): IrType => {
    const resolved = type?.kind === "named" ? types.find((candidate) => candidate.name === type.name)?.type : type;
    if (resolved?.kind !== "array")
      throw new SpecError(where, "x-channelstack-waits needs an operation that returns a list");
    return resolved.items;
  };

  const errors = new Set<string>();
  for (const [path, operations] of Object.entries<Json>(openapi.paths ?? {})) {
    for (const [verb, operation] of Object.entries<Json>(operations)) {
      const where = `${verb.toUpperCase()} ${path}`;
      const factory: Json | undefined = operation["x-channelstack-factory"];
      const binding: Json | undefined = factory ?? operation["x-channelstack-method"];
      for (const code of operation["x-channelstack-error-codes"] ?? []) errors.add(code);
      if (!binding)
        throw new SpecError(
          where,
          "has neither x-channelstack-method nor x-channelstack-factory, so no SDK could call it",
        );
      const owner = resources.get(binding.on);
      if (!owner) throw new SpecError(where, `is bound to unknown resource "${binding.on}"`);

      const bodySchema: Json | undefined = operation.requestBody?.content?.["application/json"]?.schema;
      const body = bodySchema ? resolveObject(bodySchema, schemas, where) : undefined;
      const available = new Map<string, IrParam>();
      for (const field of body ? fieldsOf(body, where) : []) {
        const property: Json = body?.properties?.[field.name] ?? {};
        const schema: Json =
          (typeof property.$ref === "string" ? schemas[property.$ref.slice(REF_PREFIX.length)] : property) ?? {};
        const shorthand: unknown = schema["x-channelstack-shorthand"];
        const credential: unknown = property["x-channelstack-credential"];
        if (credential !== undefined) {
          const named = [...String(credential).matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
          const fields = new Set(fieldsOf(body ?? {}, where).map((candidate) => candidate.name));
          if (typeof credential !== "string" || !/^[A-Z][A-Z0-9_{}a-z]*$/.test(credential) || named.some((name) => !fields.has(name))) {
            throw new SpecError(where, `x-channelstack-credential on "${field.name}" must name an env var whose {fields} are body fields`);
          }
          if (field.type.kind !== "string" || !field.optional) {
            throw new SpecError(where, `x-channelstack-credential is for an optional string, not "${field.name}"`);
          }
        }
        available.set(field.name, {
          ...field,
          in: "body",
          ...(typeof shorthand === "string" ? { shorthand } : {}),
          ...(typeof credential === "string" ? { credential } : {}),
        });
      }
      const pathParams: IrPathParam[] = [];
      for (const parameter of (operation.parameters ?? []) as Json[]) {
        if (parameter.in === "query") {
          available.set(parameter.name, {
            name: parameter.name,
            type: typeOf(parameter.schema ?? {}, `${where}?${parameter.name}`),
            optional: !parameter.required,
            in: "query",
          });
        } else if (parameter.name === "session") {
          pathParams.push({ name: "session", from: "session" });
        } else {
          // With one id field, the one path parameter left binds to it; with several, the route says which.
          const [onlyId] = owner.idFields?.length === 1 ? owner.idFields : [];
          const field: string | undefined = binding.bind?.[parameter.name] ?? onlyId;
          if (!field || !owner.fields.some((candidate) => candidate.name === field)) {
            throw new SpecError(where, `can't bind path parameter "${parameter.name}" to a field of ${owner.name}`);
          }
          pathParams.push({ name: parameter.name, from: "self", field });
        }
      }

      const take = (names: string[] | undefined) =>
        (names ?? []).map((name) => {
          const param = available.get(name);
          if (!param)
            throw new SpecError(where, `binds "${name}", which is neither a body field nor a query parameter`);
          available.delete(name);
          return param;
        });
      const args = take(binding.args);
      const options = take(binding.options);
      if (available.size > 0)
        throw new SpecError(where, `doesn't expose ${[...available.keys()].join(", ")} as an argument or option`);
      // Positional arguments are required ones. Only the last may be optional: `modal.submit(values?)`.
      const misplaced = args.find((arg, position) => arg.optional && position < args.length - 1);
      if (misplaced)
        throw new SpecError(
          where,
          `"${misplaced.name}" must be an option: only the last positional argument may be optional`,
        );

      const responseSchema: Json | undefined = operation.responses?.["200"]?.content?.["application/json"]?.schema;
      for (const wait of (operation["x-channelstack-waits"] ?? []) as Json[]) {
        const returned = responseSchema ? typeOf(responseSchema, `${where} → 200`) : null;
        if (
          wait.mode === "until" &&
          (returned === null || (wait.in !== true && (typeof wait.field !== "string" || !Array.isArray(wait.not))))
        ) {
          throw new SpecError(
            where,
            "an `until` wait needs a response, and either a `field` and the values it must leave (`not`), or `in`",
          );
        }
        const item = wait.mode === "until" && returned ? returned : itemOf(returned, where);
        owner.waits = [
          ...(owner.waits ?? []),
          {
            name: wait.name,
            mode: wait.mode,
            read: binding.name,
            item,
            ...(wait.from ? { from: wait.from } : {}),
            ...(wait.text ? { text: wait.text } : {}),
            ...(wait.filter ? { filter: true as const } : {}),
            ...(wait.mode === "next" && wait.turn ? { turn: { field: wait.turn.field, value: wait.turn.value } } : {}),
            ...(wait.mode === "until" && wait.in !== true ? { field: wait.field, not: wait.not } : {}),
            ...(wait.mode === "until" && wait.in === true
              ? { in: true as const, ...(wait.field ? { field: wait.field } : {}) }
              : {}),
            what: wait.what,
          },
        ];
      }
      owner.methods.push({
        name: binding.name,
        kind: factory ? "factory" : "method",
        summary: operation.summary ?? "",
        stability: operation["x-channelstack-stability"] ?? "experimental",
        http: { verb: verb.toUpperCase() as IrMethod["http"]["verb"], path, pathParams },
        args,
        options,
        returns: responseSchema ? typeOf(responseSchema, `${where} → 200`) : null,
        errors: operation["x-channelstack-error-codes"] ?? [],
        dispose: binding.dispose === true,
        ...(Array.isArray(binding.retryWhile) && binding.retryWhile.length > 0
          ? { retryWhile: binding.retryWhile }
          : {}),
        ...(binding.onceQuiet === true ? { onceQuiet: true as const } : {}),
      });
    }
  }

  // Only the data types a response, a handle's fields or an argument can reach are part of the SDK
  // surface; request bodies themselves are spelled out as each method's arguments and options.
  const reachable = new Set<string>();
  const visit = (type: IrType | null): void => {
    if (!type) return;
    if (type.kind === "array") visit(type.items);
    else if (type.kind === "record") visit(type.values);
    else if (type.kind === "object") for (const field of type.fields) visit(field.type);
    else if (type.kind === "union") for (const member of type.types) visit(member);
    else if (type.kind === "named" && !reachable.has(type.name)) {
      reachable.add(type.name);
      visit(types.find((candidate) => candidate.name === type.name)?.type ?? null);
    }
  };
  for (const resource of resources.values()) {
    for (const field of resource.fields) visit(field.type);
    for (const method of resource.methods) {
      visit(method.returns);
      // A named type an argument takes (a message's input) is part of the surface too.
      for (const param of [...method.args, ...method.options]) visit(param.type);
    }
  }

  return {
    version: openapi.info.version,
    basePath: openapi.servers?.[0]?.url ?? "",
    root: ROOT,
    // A resource comes after the one it extends, so emitters can declare them in this order.
    resources: [...resources.values()].sort(
      (a, b) => Number(a.extends !== undefined) - Number(b.extends !== undefined),
    ),
    types: types.filter((type) => reachable.has(type.name)),
    errors: [...errors].sort(),
  };
}

function resolveObject(schema: Json, schemas: Json, where: string): Json {
  const resolved: Json | undefined =
    typeof schema.$ref === "string" ? schemas[schema.$ref.slice(REF_PREFIX.length)] : schema;
  if (resolved?.type !== "object") throw new SpecError(where, "request bodies must be JSON objects");
  return resolved;
}
