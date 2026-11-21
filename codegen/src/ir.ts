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
  fields: IrField[];
  methods: IrMethod[];
}

/** A named data type: plain values with no identity. */
interface IrNamedType {
  name: string;
  type: IrType;
}

export interface IrField {
  name: string;
  type: IrType;
  optional: boolean;
}

export type IrType =
  | { kind: "string" | "number" | "integer" | "boolean" | "unknown" }
  | { kind: "literal"; value: string }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; items: IrType }
  | { kind: "record"; values: IrType }
  | { kind: "object"; fields: IrField[] }
  /** A named data type from `types`. */
  | { kind: "named"; name: string }
  /** In a response: the wire data of a handle, which SDKs wrap into the handle again. */
  | { kind: "resource"; name: string }
  /** In a request: a handle, sent by its id (an object of its id fields when it has several). */
  | { kind: "ref"; resources: string[] }
  /** One of several types. `discriminator` names the literal field that tells them apart. */
  | { kind: "union"; types: IrType[]; discriminator?: string };

export interface IrParam extends IrField {
  in: "body" | "query";
  /** For an object argument: a plain string is shorthand for `{ [shorthand]: string }` (`ana.say("hi", …)`). */
  shorthand?: string;
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
    const alternatives: Json[] | undefined = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(alternatives)) {
      const types = alternatives.map((alternative, index) => typeOf(alternative, `${where}|${index}`));
      const discriminator: unknown = schema.discriminator?.propertyName;
      return { kind: "union", types, ...(typeof discriminator === "string" ? { discriminator } : {}) };
    }
    if (typeof schema.const === "string") return { kind: "literal", value: schema.const };
    if (Array.isArray(schema.enum)) {
      const [first] = schema.enum;
      return schema.enum.length === 1 && typeof first === "string"
        ? { kind: "literal", value: first }
        : { kind: "enum", values: schema.enum.map(String) };
    }
    switch (schema.type) {
      case "string":
      case "number":
      case "integer":
      case "boolean":
        return { kind: schema.type };
      case "array":
        return { kind: "array", items: typeOf(schema.items ?? {}, `${where}[]`) };
      case "object": {
        if (schema.properties) return { kind: "object", fields: fieldsOf(schema, where) };
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
      types.push({ name, type: typeOf(schema, name) });
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
      fields,
      methods: [],
    });
  }

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
        available.set(field.name, { ...field, in: "body", ...(typeof shorthand === "string" ? { shorthand } : {}) });
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
      const query = args.find((arg) => arg.in === "query" || arg.optional);
      if (query)
        throw new SpecError(where, `"${query.name}" must be an option: positional arguments are required body fields`);

      const responseSchema: Json | undefined = operation.responses?.["200"]?.content?.["application/json"]?.schema;
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
    resources: [...resources.values()],
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
